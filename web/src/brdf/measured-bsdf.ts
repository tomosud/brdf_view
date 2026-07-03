// Builds a BrdfDef for an RGL EPFL measured BRDF (.bsdf tensor file, RGB
// variant). Port of rgl-epfl/brdf-loader powitacq_rgb BRDF::eval() to GLSL:
//   fr = rgb(sample) * ndf(u_wm) / (4 * sigma(u_wi)),  sample = vndf.invert(u_wm)
// where ndf/sigma/rgb are bilinear table lookups (Marginal2D::eval — the
// constructor's 1/hprod(inv_patch) prescale and eval's hprod(inv_patch)
// postscale cancel, so raw data is interpolated directly) and vndf.invert is
// the analytic CDF inversion of Marginal2D<2>, requiring per-slice
// conditional/marginal CDF tables that are precomputed here on the CPU
// (exact port of the Marginal2D build_cdf constructor branch).
//
// All tables are packed into the single R32F `measuredData` texture used by
// the MERL path (width MEASURED_TEX_WIDTH, linear-index texelFetch). Table
// offsets, resolutions and the small theta_i/phi_i grids are baked into the
// generated GLSL as constants.
//
// Note: powitacq eval() returns f_r multiplied by the cosine of the second
// argument (outgoing) direction; the viewer's BRDF() convention is plain f_r,
// so the result is divided by wo.z.

import type { BrdfDef, BrdfInstance, MeasuredData } from './types.js';
import { MEASURED_TEX_WIDTH } from '../io/merl.js';
import { parseTensorFile, fieldAsFloat32, TensorType } from '../io/bsdf-tensor.js';

const PI = 3.14159265358979323846;

function fmt(x: number): string {
  const s = x.toPrecision(9);
  return /[.e]/.test(s) ? s : s + '.0';
}

function glslArray(name: string, v: Float32Array): string {
  const vals = Array.from(v, fmt).join(', ');
  return `const float ${name}[${v.length}] = float[${v.length}](${vals});`;
}

/** Per-slice conditional/marginal CDFs + normalized density, as built by
 *  Marginal2D<2> with normalize=true, build_cdf=true. */
function buildCdfs(data: Float32Array, w: number, h: number, slices: number) {
  const dataN = new Float32Array(data.length);
  const cond = new Float32Array(data.length);
  const marg = new Float32Array(slices * h);
  for (let s = 0; s < slices; s++) {
    const dOff = s * w * h;
    const mOff = s * h;
    for (let y = 0; y < h; y++) {
      let sum = 0;
      let i = dOff + y * w;
      cond[i] = 0;
      for (let x = 0; x < w - 1; x++, i++) {
        sum += 0.5 * (data[i] + data[i + 1]);
        cond[i + 1] = sum;
      }
    }
    marg[mOff] = 0;
    let sum = 0;
    for (let y = 0; y < h - 1; y++) {
      sum += 0.5 * (cond[dOff + (y + 1) * w - 1] + cond[dOff + (y + 2) * w - 1]);
      marg[mOff + y + 1] = sum;
    }
    const total = marg[mOff + h - 1];
    const norm = total > 0 ? 1 / total : 0;
    for (let i = 0; i < w * h; i++) {
      cond[dOff + i] *= norm;
      dataN[dOff + i] = data[dOff + i] * norm;
    }
    for (let y = 0; y < h; y++) marg[mOff + y] *= norm;
  }
  return { dataN, cond, marg };
}

export function bsdfBrdfFromBuffer(name: string, buf: ArrayBuffer): BrdfInstance {
  const fields = parseTensorFile(buf);
  const need = (n: string, rank: number) => {
    const f = fields.get(n);
    if (!f || f.dtype !== TensorType.Float32 || f.shape.length !== rank) {
      throw new Error(`.bsdf: missing/invalid field "${n}"`);
    }
    return f;
  };
  const thetaI = fieldAsFloat32(need('theta_i', 1));
  const phiI = fieldAsFloat32(need('phi_i', 1));
  const ndfF = need('ndf', 2);
  const sigmaF = need('sigma', 2);
  const vndfF = need('vndf', 4);
  const rgbF = need('rgb', 5);

  const phiN = phiI.length, thetaN = thetaI.length;
  if (vndfF.shape[0] !== phiN || vndfF.shape[1] !== thetaN ||
      rgbF.shape[0] !== phiN || rgbF.shape[1] !== thetaN || rgbF.shape[2] !== 3) {
    throw new Error('.bsdf: unexpected vndf/rgb tensor shape');
  }
  const isotropic = phiN <= 2;
  if (!isotropic) {
    const reduction = Math.round((2 * PI) / (phiI[phiN - 1] - phiI[0]));
    if (reduction !== 1) throw new Error('.bsdf: reduction != 1 not supported');
  }

  // Sizes follow the reference: Vector2u(shape[last], shape[last-1]) = (W, H).
  const ndfW = ndfF.shape[1], ndfH = ndfF.shape[0];
  const sigW = sigmaF.shape[1], sigH = sigmaF.shape[0];
  const vW = vndfF.shape[3], vH = vndfF.shape[2];
  const rW = rgbF.shape[4], rH = rgbF.shape[3];
  const slices = phiN * thetaN;

  const vndf = buildCdfs(fieldAsFloat32(vndfF), vW, vH, slices);

  // Pack: [ndf, sigma, vndf data, vndf cond cdf, vndf marginal cdf, rgb]
  const blocks = [
    fieldAsFloat32(ndfF), fieldAsFloat32(sigmaF),
    vndf.dataN, vndf.cond, vndf.marg, fieldAsFloat32(rgbF),
  ];
  const offsets: number[] = [];
  let total = 0;
  for (const b of blocks) { offsets.push(total); total += b.length; }
  const texWidth = MEASURED_TEX_WIDTH;
  const texHeight = Math.ceil(total / texWidth);
  if (texHeight > 4096) throw new Error('.bsdf: data too large for texture');
  const data = new Float32Array(texWidth * texHeight);
  blocks.forEach((b, i) => data.set(b, offsets[i]));
  const [offNdf, offSig, offVndf, offVCdf, offVMarg, offRgb] = offsets;
  const measured: MeasuredData = { data, texWidth, texHeight };

  const shaderSource = `
uniform sampler2D measuredData;

const int TEX_W = ${texWidth};
const float BSDF_PI = 3.1415926535897932384626433832795;
const int PHI_N = ${phiN};
const int THETA_N = ${thetaN};
const int VNDF_W = ${vW};
const int VNDF_H = ${vH};
const int RGB_W = ${rW};
const int RGB_H = ${rH};
const int OFF_NDF = ${offNdf};
const int OFF_SIG = ${offSig};
const int OFF_VNDF = ${offVndf};
const int OFF_VCDF = ${offVCdf};
const int OFF_VMARG = ${offVMarg};
const int OFF_RGB = ${offRgb};
const bool BSDF_ISOTROPIC = ${isotropic};
${glslArray('BSDF_PHI_I', phiI)}
${glslArray('BSDF_THETA_I', thetaI)}

float bsdfFetch(int i)
{
    return texelFetch(measuredData, ivec2(i % TEX_W, i / TEX_W), 0).r;
}

// Interpolation state over the (phi_i, theta_i) parameter grid.
struct BsdfParamW {
    int i0Phi; int i1Phi; float w1Phi;
    int i0Th;  int i1Th;  float w1Th;
};

BsdfParamW bsdfParamWeights(float phiIn, float thetaIn)
{
    BsdfParamW pw;
    int i = 0;
    for (int k = 1; k <= PHI_N - 2; ++k) { if (BSDF_PHI_I[k] <= phiIn) i = k; }
    pw.i0Phi = i;
    pw.i1Phi = (PHI_N > 1) ? i + 1 : i;
    pw.w1Phi = (PHI_N > 1)
        ? clamp((phiIn - BSDF_PHI_I[pw.i0Phi]) /
                (BSDF_PHI_I[pw.i1Phi] - BSDF_PHI_I[pw.i0Phi]), 0.0, 1.0)
        : 0.0;
    i = 0;
    for (int k = 1; k <= THETA_N - 2; ++k) { if (BSDF_THETA_I[k] <= thetaIn) i = k; }
    pw.i0Th = i;
    pw.i1Th = (THETA_N > 1) ? i + 1 : i;
    pw.w1Th = (THETA_N > 1)
        ? clamp((thetaIn - BSDF_THETA_I[pw.i0Th]) /
                (BSDF_THETA_I[pw.i1Th] - BSDF_THETA_I[pw.i0Th]), 0.0, 1.0)
        : 0.0;
    return pw;
}

// Fetch element idx of a per-(phi_i, theta_i)-slice table (slice stride
// sliceSize floats), interpolating over the four surrounding slices.
float bsdfLookupP(int base, int idx, int sliceSize, BsdfParamW pw)
{
    float v00 = bsdfFetch(base + (pw.i0Phi * THETA_N + pw.i0Th) * sliceSize + idx);
    float v01 = bsdfFetch(base + (pw.i0Phi * THETA_N + pw.i1Th) * sliceSize + idx);
    float v10 = bsdfFetch(base + (pw.i1Phi * THETA_N + pw.i0Th) * sliceSize + idx);
    float v11 = bsdfFetch(base + (pw.i1Phi * THETA_N + pw.i1Th) * sliceSize + idx);
    return mix(mix(v00, v01, pw.w1Th), mix(v10, v11, pw.w1Th), pw.w1Phi);
}

// Marginal2D<0>::eval on raw data (normalization factors cancel).
float bsdfEval0(int base, int w, int h, vec2 u)
{
    vec2 p = u * vec2(float(w - 1), float(h - 1));
    ivec2 o = clamp(ivec2(p), ivec2(0), ivec2(w - 2, h - 2));
    vec2 f = p - vec2(o);
    int idx = base + o.x + o.y * w;
    float v00 = bsdfFetch(idx),     v10 = bsdfFetch(idx + 1);
    float v01 = bsdfFetch(idx + w), v11 = bsdfFetch(idx + w + 1);
    return mix(v00, v10, f.x) * (1.0 - f.y) + mix(v01, v11, f.x) * f.y;
}

// Marginal2D<3>::eval of the rgb table at channel ch (raw data; the channel
// parameter resolves to an exact slice, phi/theta interpolate).
float bsdfEvalRgb(vec2 u, int ch, BsdfParamW pw)
{
    vec2 p = u * vec2(float(RGB_W - 1), float(RGB_H - 1));
    ivec2 o = clamp(ivec2(p), ivec2(0), ivec2(RGB_W - 2, RGB_H - 2));
    vec2 f = p - vec2(o);
    int sliceSize = RGB_W * RGB_H;
    int idx = o.x + o.y * RGB_W;
    float v00, v10, v01, v11, c0, c1, r = 0.0;
    // phi/theta corner slices, channel stride 1, theta stride 3, phi stride 3*THETA_N
    for (int j = 0; j < 4; ++j) {
        int pi = (j < 2) ? pw.i0Phi : pw.i1Phi;
        int ti = (j == 0 || j == 2) ? pw.i0Th : pw.i1Th;
        float wgt = ((j < 2) ? (1.0 - pw.w1Phi) : pw.w1Phi) *
                    ((j == 0 || j == 2) ? (1.0 - pw.w1Th) : pw.w1Th);
        int base = OFF_RGB + ((pi * THETA_N + ti) * 3 + ch) * sliceSize + idx;
        v00 = bsdfFetch(base);         v10 = bsdfFetch(base + 1);
        v01 = bsdfFetch(base + RGB_W); v11 = bsdfFetch(base + RGB_W + 1);
        c0 = mix(v00, v10, f.x);
        c1 = mix(v01, v11, f.x);
        r += wgt * mix(c0, c1, f.y);
    }
    return r;
}

// Marginal2D<2>::invert — maps a position in the warped domain back to the
// uniform sample that generates it (direct CDF evaluation, no search).
vec2 bsdfVndfInvert(vec2 u, BsdfParamW pw)
{
    vec2 s = u * vec2(float(VNDF_W - 1), float(VNDF_H - 1));
    ivec2 pos = clamp(ivec2(s), ivec2(0), ivec2(VNDF_W - 2, VNDF_H - 2));
    s -= vec2(pos);
    int sliceSize = VNDF_W * VNDF_H;
    int off = pos.x + pos.y * VNDF_W;

    float v00 = bsdfLookupP(OFF_VNDF, off, sliceSize, pw);
    float v10 = bsdfLookupP(OFF_VNDF, off + 1, sliceSize, pw);
    float v01 = bsdfLookupP(OFF_VNDF, off + VNDF_W, sliceSize, pw);
    float v11 = bsdfLookupP(OFF_VNDF, off + VNDF_W + 1, sliceSize, pw);

    float w0y = 1.0 - s.y, w1y = s.y;
    float c0 = w0y * v00 + w1y * v01;
    float c1 = w0y * v10 + w1y * v11;

    s.x *= c0 + 0.5 * s.x * (c1 - c0);
    s.x += w0y * bsdfLookupP(OFF_VCDF, off, sliceSize, pw) +
           w1y * bsdfLookupP(OFF_VCDF, off + VNDF_W, sliceSize, pw);

    int rowOff = pos.y * VNDF_W;
    float r0 = bsdfLookupP(OFF_VCDF, rowOff + VNDF_W - 1, sliceSize, pw);
    float r1 = bsdfLookupP(OFF_VCDF, rowOff + 2 * VNDF_W - 1, sliceSize, pw);
    s.x /= w0y * r0 + w1y * r1;

    s.y *= r0 + 0.5 * s.y * (r1 - r0);
    s.y += bsdfLookupP(OFF_VMARG, pos.y, VNDF_H, pw);
    return s;
}

// Numerically robust acos(d.z)
float bsdfElevation(vec3 d)
{
    float dz = d.z - 1.0;
    return 2.0 * asin(0.5 * sqrt(d.x * d.x + d.y * d.y + dz * dz));
}

float bsdfTheta2u(float theta) { return sqrt(theta * (2.0 / BSDF_PI)); }
float bsdfPhi2u(float phi)     { return (phi + BSDF_PI) / (2.0 * BSDF_PI); }

float bsdfAtan2(float y, float x)
{
    return (abs(x) < 1e-12 && abs(y) < 1e-12) ? 0.0 : atan(y, x);
}

vec3 BRDF( vec3 toLight, vec3 toViewer, vec3 normal, vec3 tangent, vec3 bitangent )
{
    vec3 wi = vec3(dot(toLight, tangent),  dot(toLight, bitangent),  dot(toLight, normal));
    vec3 wo = vec3(dot(toViewer, tangent), dot(toViewer, bitangent), dot(toViewer, normal));
    if (wi.z <= 0.0 || wo.z <= 0.0) return vec3(0.0);
    wi = normalize(wi);
    wo = normalize(wo);
    vec3 wm = normalize(wi + wo);

    float thetaIn = bsdfElevation(wi);
    float phiIn   = bsdfAtan2(wi.y, wi.x);
    float thetaM  = bsdfElevation(wm);
    float phiM    = bsdfAtan2(wm.y, wm.x);

    vec2 uWi = vec2(bsdfTheta2u(thetaIn), bsdfPhi2u(phiIn));
    vec2 uWm = vec2(bsdfTheta2u(thetaM),
                    bsdfPhi2u(BSDF_ISOTROPIC ? (phiM - phiIn) : phiM));
    uWm.y -= floor(uWm.y);

    BsdfParamW pw = bsdfParamWeights(phiIn, thetaIn);
    vec2 s = clamp(bsdfVndfInvert(uWm, pw), 0.0, 1.0);

    vec3 fr = vec3(bsdfEvalRgb(s, 0, pw),
                   bsdfEvalRgb(s, 1, pw),
                   bsdfEvalRgb(s, 2, pw));
    fr = max(fr, vec3(0.0));
    fr *= bsdfEval0(OFF_NDF, ${ndfW}, ${ndfH}, uWm) /
          (4.0 * bsdfEval0(OFF_SIG, ${sigW}, ${sigH}, uWi));

    // powitacq eval() includes the outgoing cosine; the viewer wants plain f_r.
    return max(fr, vec3(0.0)) / max(wo.z, 1e-4);
}
`;

  const def: BrdfDef = {
    name,
    params: [],
    shaderSource,
    isFuncSource: null,
    noPromote: true,
    measured,
  };
  return { id: `bsdf-${counter++}`, def, values: new Map(), visible: true };
}

let counter = 0;
