// Display transform shared by Lit Object, Lit Sphere and Image Slice.
//
// toneMapMode (DisplayMode):
//   0 SDR: the original display (exposure, then pow(1 / gamma), clamp to 0-1).
//   1 ACES 2.0 SDR: Output Transform, 100 nits, Rec.709 limiting primaries, sRGB
//     piecewise encoding. Same as the OCIO ACES studio config "sRGB - Display" /
//     "ACES 2.0 - SDR 100 nits (Rec.709)" with the input "Linear Rec.709 (sRGB)"
//     (renders are linear Rec.709). Gamma is not used.
//   2 ACES 2.0 HDR: 1000 nits, P3-D65 limiting primaries, for a float16
//     drawing buffer in display-p3 with extended sRGB encoding (Chrome shows
//     values above 1 brighter than SDR white). Same as OCIO "Display P3 HDR -
//     Display" / "ACES 2.0 - HDR 1000 nits (P3 D65)" except that 1.0 is SDR white
//     = 203 nits (ITU-R BT.2408, Chrome's default) instead of 100 nits, i.e. the
//     ACES linear_scale_factor is 100 / 203.
//   3 HDR without tone mapping: mode 0 without the clamp at 1 (sRGB canvas).
//
// TONEMAP_GLSL is the per-pixel part of the forward transform, ported from the
// ACES 2.0 CTL (aces-aswf/aces-core, Apache-2.0); it must match
// outputTransformFwd() in aces2.ts, which is the CPU reference. Parameters and
// the hue tables are precomputed by aces2.ts and bound by ToneMapper.

import {
  AP0, AP1, initODTParams, mul33, P3_D65, REC709, REC709_TO_AP0, rgbToXyz, TOTAL_TABLE_SIZE, xyzToRgb, inv33,
  type ODTParams,
} from './aces2.js';
import type { Uniforms } from './renderer.js';

/** Texture unit of the ACES tables (parameter images use 5-12). */
export const TONEMAP_TABLE_UNIT = 13;

/** 0 SDR, 1 ACES SDR, 2 ACES HDR, 3 HDR without tone mapping (see the header). */
export type DisplayMode = 0 | 1 | 2 | 3;

/** Luminance of display value 1.0 (SDR white) in HDR output, in nits (ITU-R BT.2408). */
export const HDR_SDR_WHITE_NITS = 203;
/** Peak luminance of the HDR tone map, in nits. */
export const HDR_PEAK_NITS = 1000;

export const TONEMAP_GLSL = /* glsl */ `
// ---- display tone mapping (src/gl/tonemap.ts) ----
uniform int toneMapMode; // DisplayMode: 0 SDR, 1 ACES SDR, 2 ACES HDR, 3 HDR (no tone map)
uniform float acesOutScale; // display value per 100 nits (1 SDR, 100/203 HDR)
// ${TOTAL_TABLE_SIZE} x 2 RGBA32F: row 0 [cusp J, cusp M, hue, upper hull gamma^-1], row 1 [reach M]
uniform highp sampler2D acesTable;
uniform mat3 acesInToAP1;    // linear Rec.709 -> AP1 (row-major CTL matrices: m * v)
uniform mat3 acesAP1ToCam;   // AP1 -> AP0 -> CAM16 cone response (input params)
uniform mat3 acesConeToAab;
uniform mat3 acesAabToCone;
uniform mat3 acesCamToLimit; // cone response -> limiting RGB
uniform vec4 acesCam;        // F_L_n, cz, A_w_J, forward limit
uniform vec4 acesTs;         // m_2, s_2, g, t_1
uniform vec4 acesChroma;     // limit J max, model gamma^-1, sat, sat_thr
uniform vec4 acesChroma2;    // compr, chroma compress scale, mid J, focus distance
uniform vec4 acesGamut;      // lower hull gamma^-1, peak (1 = 100 nits), hue search range lo, hi

float acesCompressFwd(float v)
{
    float f = pow(abs(v), 0.42);
    return sign(v) * f / (27.13 + f);
}

float acesCompressInv(float v)
{
    float a = min(abs(v), 0.99);
    return sign(v) * pow(27.13 * a / (1.0 - a), 1.0 / 0.42);
}

float acesJToY(float J)
{
    float A = pow(abs(J) * 0.01, 1.0 / acesCam.y);
    return acesCompressInv(acesCam.z * A) / acesCam.x;
}

float acesYToJ(float Y)
{
    float Ra = acesCompressFwd(abs(Y) * acesCam.x);
    return sign(Y) * 100.0 * pow(Ra / acesCam.z, acesCam.y);
}

vec3 acesJMhFromAP1(vec3 ap1)
{
    vec3 cone = acesAP1ToCam * ap1;
    vec3 Aab = acesConeToAab * vec3(acesCompressFwd(cone.x), acesCompressFwd(cone.y), acesCompressFwd(cone.z));
    if (Aab.x <= 0.0) return vec3(0.0);
    float M = length(Aab.yz);
    float h = M > 0.0 ? degrees(atan(Aab.z, Aab.y)) : 0.0;
    if (h < 0.0) h += 360.0;
    return vec3(100.0 * pow(Aab.x, acesCam.y), M, h);
}

vec3 acesRgbFromJMh(vec3 JMh)
{
    float A = pow(max(JMh.x, 0.0) * 0.01, 1.0 / acesCam.y);
    float hr = radians(JMh.z);
    vec3 cone = acesAabToCone * vec3(A, JMh.y * cos(hr), JMh.y * sin(hr));
    return acesCamToLimit * vec3(acesCompressInv(cone.x), acesCompressInv(cone.y), acesCompressInv(cone.z));
}

vec4 acesRow(int i)
{
    return texelFetch(acesTable, ivec2(i, 0), 0);
}

float acesReachM(float h)
{
    int base = int(h); // 1 degree per entry
    float t = h - float(base);
    return mix(texelFetch(acesTable, ivec2(base + 1, 1), 0).r, texelFetch(acesTable, ivec2(base + 2, 1), 0).r, t);
}

float acesToe(float x, float limit, float k1In, float k2In)
{
    if (x > limit) return x;
    float k2 = max(k2In, 0.001);
    float k1 = sqrt(k1In * k1In + k2 * k2);
    float k3 = (limit + k1) / (limit + k2);
    float minusB = k3 * x - k1;
    float minusC = k2 * k3 * x;
    return 0.5 * (minusB + sqrt(minusB * minusB + 4.0 * minusC));
}

float acesChromaCompressNorm(float h)
{
    float hr = radians(h);
    float a = cos(hr);
    float b = sin(hr);
    float M = 11.34072 * a + 16.46899 * (a * a - b * b) + 7.88380 * (4.0 * a * a * a - 3.0 * a)
            + 14.66441 * b - 6.37224 * (2.0 * a * b) + 9.19364 * (3.0 * b - 4.0 * b * b * b) + 77.12896;
    return M * acesChroma2.y;
}

vec3 acesChromaCompress(vec3 JMh, float Jts)
{
    float M = JMh.y;
    if (M != 0.0) {
        float nJ = Jts / acesChroma.x;
        float snJ = max(0.0, 1.0 - nJ);
        float Mnorm = acesChromaCompressNorm(JMh.z);
        float limit = pow(nJ, acesChroma.y) * acesReachM(JMh.z) / Mnorm;
        M = M * pow(Jts / JMh.x, acesChroma.y) / Mnorm;
        M = limit - acesToe(limit - M, limit - 0.001, snJ * acesChroma.z, sqrt(nJ * nJ + acesChroma.w));
        M = acesToe(M, limit, nJ * acesChroma2.x, snJ) * Mnorm;
    }
    return vec3(Jts, M, JMh.z);
}

float acesSolveJIntersect(float J, float M, float focusJ, float maxJ, float slopeGain)
{
    float Ms = M / slopeGain;
    float a = Ms / focusJ;
    if (J < focusJ) {
        float b = 1.0 - Ms;
        float c = -J;
        return -2.0 * c / (b + sqrt(b * b - 4.0 * a * c));
    }
    float b = -(1.0 + Ms + maxJ * a);
    float c = maxJ * Ms + J;
    return -2.0 * c / (b - sqrt(b * b - 4.0 * a * c));
}

float acesBoundaryM(float Jaxis, float slope, float invGamma, float Jmax, float Mmax, float Jref)
{
    float shifted = Jref * pow(Jaxis / Jref, invGamma);
    return shifted * Mmax / (Jmax - slope * Mmax);
}

vec3 acesGamutCompress(vec3 JMh)
{
    float J = JMh.x;
    float M = JMh.y;
    float h = JMh.z;
    float limitJ = acesChroma.x;
    if (J <= 0.0) return vec3(0.0, 0.0, h);
    if (M < 0.0 || J > limitJ) return vec3(J, 0.0, h);

    // hue interval for the upper hull gamma (lookup_hue_interval)
    int i = 1 + int(h / 360.0 * ${TOTAL_TABLE_SIZE}.0);
    int iLo = max(1, i + int(acesGamut.z));
    int iHi = min(${TOTAL_TABLE_SIZE - 1}, i + int(acesGamut.w));
    for (int k = 0; k < 16 && iLo + 1 < iHi; k++) {
        if (h > acesRow(i).z) iLo = i;
        else iHi = i;
        i = (iLo + iHi) / 2;
    }
    iHi = max(1, iHi);
    float gTopInv = mix(acesRow(iHi - 1).w, acesRow(iHi).w, h - acesRow(iHi - 1).z);

    // cusp (cusp_from_table)
    int lowI = 0;
    int highI = ${TOTAL_TABLE_SIZE - 1};
    i = int(h) + 1;
    for (int k = 0; k < 16 && lowI + 1 < highI; k++) {
        if (h > acesRow(i).z) lowI = i;
        else highI = i;
        i = (lowI + highI) / 2;
    }
    vec4 lo = acesRow(highI - 1);
    vec4 hi = acesRow(highI);
    vec2 cusp = mix(lo.xy, hi.xy, (h - lo.z) / (hi.z - lo.z));

    float focusJ = mix(cusp.x, acesChroma2.z, min(1.0, 1.3 - cusp.x / limitJ));
    float threshold = mix(cusp.x, limitJ, 0.3);
    float gain = limitJ * acesChroma2.w;
    if (J > threshold) {
        float adj = log((limitJ - threshold) / max(0.0001, limitJ - J)) / log(10.0);
        gain *= adj * adj + 1.0;
    }
    float JiSource = acesSolveJIntersect(J, M, focusJ, limitJ, gain);
    float dir = JiSource < focusJ ? JiSource : limitJ - JiSource;
    float slope = dir * (JiSource - focusJ) / (focusJ * gain);
    float JiCusp = acesSolveJIntersect(cusp.x, cusp.y, focusJ, limitJ, gain);

    float lower = acesBoundaryM(JiSource, slope, acesGamut.x, cusp.x, cusp.y, JiCusp);
    float upper = acesBoundaryM(limitJ - JiSource, -slope, gTopInv, limitJ - cusp.x, cusp.y, limitJ - JiCusp);
    float s = 0.12 * cusp.y;
    float hs = max(s - abs(lower - upper), 0.0) / s;
    float gamutM = min(lower, upper) - hs * hs * hs * s / 6.0;
    if (gamutM <= 0.0) return vec3(J, 0.0, h);

    float reachM = acesBoundaryM(JiSource, slope, acesChroma.y, limitJ, acesReachM(h), limitJ);
    float proportion = max(gamutM / reachM, 0.75);
    float thr = proportion * gamutM;
    if (M > thr && proportion < 1.0) {
        float gamutOffset = gamutM - thr;
        float reachOffset = reachM - thr;
        float scale = reachOffset / (reachOffset / gamutOffset - 1.0);
        float nd = (M - thr) / scale;
        M = thr + scale * nd / (1.0 + nd);
    }
    return vec3(JiSource + M * slope, M, h);
}

// Linear Rec.709 scene values -> display-linear limiting RGB (1 = 100 nits).
vec3 aces2OutputTransform(vec3 rgb)
{
    vec3 ap1 = clamp(acesInToAP1 * rgb, 0.0, acesCam.w);
    vec3 JMh = acesJMhFromAP1(ap1);
    float linear = acesJToY(JMh.x) * 0.01;
    float f = acesTs.x * pow(max(0.0, linear) / (linear + acesTs.y), acesTs.z);
    float Jts = acesYToJ(max(0.0, f * f / (f + acesTs.w)) * 100.0);
    vec3 compressed = acesGamutCompress(acesChromaCompress(JMh, Jts));
    return clamp(acesRgbFromJMh(compressed), 0.0, acesGamut.y);
}

vec3 srgbEncode(vec3 x)
{
    vec3 lo = x * 12.92;
    vec3 hi = 1.055 * pow(x, vec3(1.0 / 2.4)) - 0.055;
    return mix(hi, lo, vec3(lessThanEqual(x, vec3(0.0031308))));
}

// Exposed scene values -> encoded display values. Modes 2 and 3 may exceed 1.
vec3 displayEncode(vec3 rgb, float gamma)
{
    if (toneMapMode == 1 || toneMapMode == 2) return srgbEncode(aces2OutputTransform(rgb) * acesOutScale);
    return pow(max(rgb, vec3(0.0)), vec3(1.0 / gamma));
}

// Final clamp of the displayed value: 0-1 for SDR, only >= 0 for HDR.
vec3 displayLimit(vec3 c)
{
    return toneMapMode >= 2 ? max(c, vec3(0.0)) : clamp(c, 0.0, 1.0);
}
`;

let sdrParams: ODTParams | null = null;
let hdrParams: ODTParams | null = null;
/** ACES 2.0 parameters (SDR: 100 nits Rec.709, HDR: 1000 nits P3-D65), each built once (about 15 ms). */
export function acesParams(hdr: boolean): ODTParams {
  if (hdr) return (hdrParams ??= initODTParams(HDR_PEAK_NITS, P3_D65));
  return (sdrParams ??= initODTParams(100, REC709));
}

/** Per-GL-context binding of the display transform uniforms and tables. */
export class ToneMapper {
  private tables = new Map<ODTParams, WebGLTexture>();

  constructor(private gl: WebGL2RenderingContext) {}

  /** Set the display uniforms of a program that includes TONEMAP_GLSL. */
  apply(u: Uniforms, mode: DisplayMode): void {
    u.i('toneMapMode', mode);
    if (mode !== 1 && mode !== 2) return;
    const gl = this.gl;
    const p = acesParams(mode === 2);
    u.f('acesOutScale', mode === 2 ? 100 / HDR_SDR_WHITE_NITS : 1);
    const ap0ToAp1 = mul33(rgbToXyz(AP0), xyzToRgb(AP1));
    const m3 = (name: string, m: number[]) => {
      const l = u.loc(name);
      if (l) gl.uniformMatrix3fv(l, false, m);
    };
    m3('acesInToAP1', mul33(REC709_TO_AP0, ap0ToAp1));
    m3('acesAP1ToCam', mul33(inv33(ap0ToAp1), p.input.rgbToCam));
    m3('acesConeToAab', p.input.coneToAab);
    m3('acesAabToCone', p.limit.aabToCone);
    m3('acesCamToLimit', p.limit.camToRgb);
    const v4 = (name: string, a: number, b: number, c: number, d: number) => {
      const l = u.loc(name);
      if (l) gl.uniform4f(l, a, b, c, d);
    };
    v4('acesCam', p.input.F_L_n, p.input.cz, p.input.A_w_J, p.ts.forward_limit);
    v4('acesTs', p.ts.m_2, p.ts.s_2, p.ts.g, p.ts.t_1);
    v4('acesChroma', p.limit_J_max, p.model_gamma_inv, p.sat, p.sat_thr);
    v4('acesChroma2', p.compr, p.chroma_compress_scale, p.mid_J, p.focus_dist);
    v4('acesGamut', p.lower_hull_gamma_inv, p.peakLuminance / 100, p.hueLinearitySearchRange[0], p.hueLinearitySearchRange[1]);
    gl.activeTexture(gl.TEXTURE0 + TONEMAP_TABLE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.ensureTable(p));
    u.i('acesTable', TONEMAP_TABLE_UNIT);
    gl.activeTexture(gl.TEXTURE0);
  }

  private ensureTable(p: ODTParams): WebGLTexture {
    const cached = this.tables.get(p);
    if (cached) return cached;
    const gl = this.gl;
    const data = new Float32Array(TOTAL_TABLE_SIZE * 2 * 4);
    for (let i = 0; i < TOTAL_TABLE_SIZE; i++) {
      data.set([p.tableGamutCusps[i * 3], p.tableGamutCusps[i * 3 + 1], p.tableHues[i], p.tableUpperHullGamma[i]], i * 4);
      data[(TOTAL_TABLE_SIZE + i) * 4] = p.tableReachM[i];
    }
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TOTAL_TABLE_SIZE, 2, 0, gl.RGBA, gl.FLOAT, data);
    this.tables.set(p, t);
    return t;
  }
}

/** The browser can give a WebGL2 canvas a float16 drawing buffer. */
export function hdrCanvasSupported(): boolean {
  return typeof (WebGL2RenderingContext.prototype as { drawingBufferStorage?: unknown }).drawingBufferStorage === 'function';
}

const hdrQuery = typeof matchMedia === 'function' ? matchMedia('(dynamic-range: high)') : null;
/** The window is on a display that shows HDR (Windows: "Use HDR" on). */
export function hdrDisplayActive(): boolean {
  return !!hdrQuery?.matches;
}
/** Call `fn` when the window moves between SDR and HDR displays. */
export function onHdrDisplayChange(fn: () => void): void {
  hdrQuery?.addEventListener('change', fn);
}
