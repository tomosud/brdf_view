// ACES 2.0 Output Transform: parameter / table setup and a CPU reference of
// the forward transform.
//
// Port of the ACES 2.0 CTL (aces-aswf/aces-core lib/Lib.Academy.OutputTransform.ctl,
// Lib.Academy.Tonescale.ctl; Apache-2.0, Copyright Contributors to the ACES
// Project; see web/public/licenses/ACES-LICENSE.txt). Only the forward transform
// is ported. The per-pixel part also exists in GLSL (src/gl/tonemap.ts); keep
// the two in step.
//
// Matrices follow the CTL convention: row-major 3x3, applied to row vectors
// (out = v * M). Uploaded to GLSL without transposing, `m * v` gives the same.

export type M3 = number[];
/** Chromaticities: red, green, blue, white (x, y). */
export type Chromaticities = [[number, number], [number, number], [number, number], [number, number]];

export const AP0: Chromaticities = [[0.7347, 0.2653], [0.0, 1.0], [0.0001, -0.077], [0.32168, 0.33767]];
export const AP1: Chromaticities = [[0.713, 0.293], [0.165, 0.83], [0.128, 0.044], [0.32168, 0.33767]];
export const REC709: Chromaticities = [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06], [0.3127, 0.329]];
export const P3_D65: Chromaticities = [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06], [0.3127, 0.329]];
export const REC2020: Chromaticities = [[0.708, 0.292], [0.17, 0.797], [0.131, 0.046], [0.3127, 0.329]];

/**
 * Linear Rec.709 (sRGB primaries, D65) to ACES2065-1 (AP0, D60), CAT02 adaptation:
 * the "Linear Rec.709 (sRGB)" -> "ACES2065-1" matrix of the OCIO ACES studio
 * config (v4.0.0, ACES 2.0), row-major for column vectors, transposed here.
 */
export const REC709_TO_AP0: M3 = transpose([
  0.4396329819194919, 0.3829886981515535, 0.1773783199289555,
  0.08977644295884223, 0.813439428748978, 0.0967841282921771,
  0.01754117038317279, 0.1115465533023872, 0.8709122763144425,
]);

// ---- constants (Lib.Academy.OutputTransform.ctl) ----
export const TABLE_SIZE = 360;
export const TOTAL_TABLE_SIZE = TABLE_SIZE + 2;
const BASE_INDEX = 1;
const HUE_LIMIT = 360;
const CUSP_CORNER_COUNT = 6;
const TOTAL_CORNER_COUNT = CUSP_CORNER_COUNT + 2;
const MAX_SORTED_CORNERS = 2 * CUSP_CORNER_COUNT;
const REACH_CUSP_TOLERANCE = 1e-3;
const DISPLAY_CUSP_TOLERANCE = 1e-7;
const GAMMA_MINIMUM = 0.0;
const GAMMA_MAXIMUM = 5.0;
const GAMMA_SEARCH_STEP = 0.4;
const GAMMA_ACCURACY = 1e-5;

export const REF_LUMINANCE = 100;
const L_A = 100;
const Y_B = 20;
const SURROUND = [0.9, 0.59, 0.9];
const J_SCALE = 100;
const CAM_NL_Y_REFERENCE = 100;
const CAM_NL_OFFSET = 0.2713 * CAM_NL_Y_REFERENCE;
const CAM_NL_SCALE = 4.0 * CAM_NL_Y_REFERENCE;
const MODEL_GAMMA = SURROUND[1] * (1.48 + Math.sqrt(Y_B / REF_LUMINANCE));

const CHROMA_COMPRESS = 2.4;
const CHROMA_COMPRESS_FACT = 3.3;
const CHROMA_EXPAND = 1.3;
const CHROMA_EXPAND_FACT = 0.69;
const CHROMA_EXPAND_THR = 0.5;

const SMOOTH_CUSPS = 0.12;
const SMOOTH_M = 0.27;
const CUSP_MID_BLEND = 1.3;
const FOCUS_GAIN_BLEND = 0.3;
const FOCUS_ADJUST_GAIN = 0.55;
const FOCUS_DISTANCE = 1.35;
const FOCUS_DISTANCE_SCALING = 1.75;
const COMPRESSION_THRESHOLD = 0.75;
void FOCUS_ADJUST_GAIN; // defined by the CTL but unused there as well

// ---- matrix helpers ----
function transpose(m: M3): M3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}
export function mul33(a: M3, b: M3): M3 {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  return r;
}
/** Row vector times matrix (CTL mult_f3_f33). */
export function vmul(v: number[], m: M3): number[] {
  return [
    v[0] * m[0] + v[1] * m[3] + v[2] * m[6],
    v[0] * m[1] + v[1] * m[4] + v[2] * m[7],
    v[0] * m[2] + v[1] * m[5] + v[2] * m[8],
  ];
}
export function inv33(m: M3): M3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}
const IDENTITY: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
function scaleM(s: number, m: M3): M3 {
  return m.map((x) => x * s);
}

/** CTL RGBtoXYZ_f33 (row-vector convention). */
export function rgbToXyz(C: Chromaticities, Y = 1): M3 {
  const [[rx, ry], [gx, gy], [bx, by], [wx, wy]] = C;
  const X = (wx * Y) / wy;
  const Z = ((1 - wx - wy) * Y) / wy;
  const d = rx * (by - gy) + bx * (gy - ry) + gx * (ry - by);
  const Sr = (X * (by - gy) - gx * (Y * (by - 1) + by * (X + Z)) + bx * (Y * (gy - 1) + gy * (X + Z))) / d;
  const Sg = (X * (ry - by) + rx * (Y * (by - 1) + by * (X + Z)) - bx * (Y * (ry - 1) + ry * (X + Z))) / d;
  const Sb = (X * (gy - ry) - rx * (Y * (gy - 1) + gy * (X + Z)) + gx * (Y * (ry - 1) + ry * (X + Z))) / d;
  return [
    Sr * rx, Sr * ry, Sr * (1 - rx - ry),
    Sg * gx, Sg * gy, Sg * (1 - gx - gy),
    Sb * bx, Sb * by, Sb * (1 - bx - by),
  ];
}
export function xyzToRgb(C: Chromaticities, Y = 1): M3 {
  return inv33(rgbToXyz(C, Y));
}

// ---- tonescale (Lib.Academy.Tonescale.ctl) ----
export interface TSParams {
  n: number;
  n_r: number;
  g: number;
  t_1: number;
  c_t: number;
  s_2: number;
  u_2: number;
  m_2: number;
  forward_limit: number;
  inverse_limit: number;
  log_peak: number;
}

function initTSParams(peakLuminance: number): TSParams {
  const n = peakLuminance;
  const n_r = 100.0;
  const g = 1.15;
  const c = 0.18;
  const c_d = 10.013;
  const w_g = 0.14;
  const t_1 = 0.04;
  const r_hit_min = 128;
  const r_hit_max = 896;
  const r_hit = r_hit_min + (r_hit_max - r_hit_min) * (Math.log(n / n_r) / Math.log(10000 / 100));
  const m_0 = n / n_r;
  const m_1 = 0.5 * (m_0 + Math.sqrt(m_0 * (m_0 + 4 * t_1)));
  const u = Math.pow(r_hit / m_1 / (r_hit / m_1 + 1), g);
  const m = m_1 / u;
  const w_i = Math.log(n / 100) / Math.log(2);
  const c_t = (c_d / n_r) * (1 + w_i * w_g);
  const g_ip = 0.5 * (c_t + Math.sqrt(c_t * (c_t + 4 * t_1)));
  const g_ipp2 = -(m_1 * Math.pow(g_ip / m, 1 / g)) / (Math.pow(g_ip / m, 1 / g) - 1);
  const w_2 = c / g_ipp2;
  const s_2 = w_2 * m_1;
  const u_2 = Math.pow(r_hit / m_1 / (r_hit / m_1 + w_2), g);
  const m_2 = m_1 / u_2;
  return {
    n, n_r, g, t_1, c_t, s_2, u_2, m_2,
    forward_limit: 8.0 * r_hit,
    inverse_limit: n / (u_2 * n_r),
    log_peak: Math.log10(n / n_r),
  };
}

function tonescaleFwd(x: number, p: TSParams): number {
  const f = p.m_2 * Math.pow(Math.max(0, x) / (x + p.s_2), p.g);
  const h = Math.max(0, (f * f) / (f + p.t_1));
  return h * p.n_r;
}

// ---- CAM (Hellwig 2022 based JMh) ----
export interface JMhParams {
  rgbToCam: M3;
  camToRgb: M3;
  coneToAab: M3;
  aabToCone: M3;
  F_L_n: number;
  cz: number;
  inv_cz: number;
  A_w_J: number;
  inv_A_w_J: number;
}

function compressFwdScalar(Rc: number): number {
  const F_L_Y = Math.pow(Rc, 0.42);
  return F_L_Y / (CAM_NL_OFFSET + F_L_Y);
}
function compressInvScalar(Ra: number): number {
  const Ra_lim = Math.min(Ra, 0.99);
  const F_L_Y = (CAM_NL_OFFSET * Ra_lim) / (1 - Ra_lim);
  return Math.pow(F_L_Y, 1 / 0.42);
}
function compressFwd(v: number): number {
  return Math.sign(v) * compressFwdScalar(Math.abs(v)) || 0;
}
function compressInv(v: number): number {
  return Math.sign(v) * compressInvScalar(Math.abs(v)) || 0;
}

function initJMhParams(prims: Chromaticities): JMhParams {
  const CAM16_PRI: Chromaticities = [[0.8336, 0.1735], [2.3854, -1.4659], [0.087, -0.125], [0.333, 0.333]];
  const MATRIX_16 = xyzToRgb(CAM16_PRI, 1);
  const baseConeToAab: M3 = [2, 1, 1 / 9, 1, -12 / 11, 1 / 9, 1 / 20, 1 / 11, -2 / 9];
  const RGB_TO_XYZ = rgbToXyz(prims, 1);
  const XYZ_w = vmul([REF_LUMINANCE, REF_LUMINANCE, REF_LUMINANCE], RGB_TO_XYZ);
  const Y_w = XYZ_w[1];
  const RGB_w = vmul(XYZ_w, MATRIX_16);
  const k = 1 / (5 * L_A + 1);
  const k4 = k * k * k * k;
  const F_L = 0.2 * k4 * (5 * L_A) + 0.1 * Math.pow(1 - k4, 2) * Math.pow(5 * L_A, 1 / 3);
  const F_L_n = F_L / REF_LUMINANCE;
  const cz = MODEL_GAMMA;
  const D_RGB = [(F_L_n * Y_w) / RGB_w[0], (F_L_n * Y_w) / RGB_w[1], (F_L_n * Y_w) / RGB_w[2]];
  const RGB_wc = [D_RGB[0] * RGB_w[0], D_RGB[1] * RGB_w[1], D_RGB[2] * RGB_w[2]];
  const RGB_Aw = RGB_wc.map(compressFwd);
  const coneToAabScaled = mul33(scaleM(CAM_NL_SCALE, IDENTITY), baseConeToAab);
  const A_w = coneToAabScaled[0] * RGB_Aw[0] + coneToAabScaled[3] * RGB_Aw[1] + coneToAabScaled[6] * RGB_Aw[2];
  const A_w_J = compressFwdScalar(F_L);
  const M1 = mul33(RGB_TO_XYZ, MATRIX_16);
  const M2 = scaleM(REF_LUMINANCE, IDENTITY);
  const rgbToCam16 = mul33(M1, M2);
  const D: M3 = [D_RGB[0], 0, 0, 0, D_RGB[1], 0, 0, 0, D_RGB[2]];
  const rgbToCam = mul33(rgbToCam16, D);
  const s = 43 * SURROUND[2];
  const coneToAab: M3 = [
    coneToAabScaled[0] / A_w, coneToAabScaled[1] * s, coneToAabScaled[2] * s,
    coneToAabScaled[3] / A_w, coneToAabScaled[4] * s, coneToAabScaled[5] * s,
    coneToAabScaled[6] / A_w, coneToAabScaled[7] * s, coneToAabScaled[8] * s,
  ];
  return {
    rgbToCam,
    camToRgb: inv33(rgbToCam),
    coneToAab,
    aabToCone: inv33(coneToAab),
    F_L_n,
    cz,
    inv_cz: 1 / cz,
    A_w_J,
    inv_A_w_J: 1 / A_w_J,
  };
}

function wrapTo360(h: number): number {
  const y = h % 360;
  return y < 0 ? y + 360 : y;
}
function huePositionInUniformTable(h: number, size: number): number {
  return Math.trunc((wrapTo360(h) / HUE_LIMIT) * size);
}
function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a);
}

function achromaticToJ(A: number, cz: number): number {
  return J_SCALE * Math.pow(A, cz);
}
function jToAchromatic(J: number, inv_cz: number): number {
  return Math.pow(J / J_SCALE, inv_cz);
}
function jToY(J: number, p: JMhParams): number {
  const A = jToAchromatic(Math.abs(J), p.inv_cz);
  return compressInvScalar(p.A_w_J * A) / p.F_L_n;
}
function yToJ(Y: number, p: JMhParams): number {
  const Ra = compressFwdScalar(Math.abs(Y) * p.F_L_n);
  const J = achromaticToJ(Ra * p.inv_A_w_J, p.cz);
  return Y < 0 ? -J : J;
}
function rgbToAab(rgb: number[], p: JMhParams): number[] {
  const m = vmul(rgb, p.rgbToCam);
  return vmul(m.map(compressFwd), p.coneToAab);
}
function aabToJMh(Aab: number[], p: JMhParams): number[] {
  if (Aab[0] <= 0) return [0, 0, 0];
  const J = achromaticToJ(Aab[0], p.cz);
  const M = Math.sqrt(Aab[1] * Aab[1] + Aab[2] * Aab[2]);
  const h = wrapTo360((Math.atan2(Aab[2], Aab[1]) * 180) / Math.PI);
  return [J, M, h];
}
export function rgbToJMh(rgb: number[], p: JMhParams): number[] {
  return aabToJMh(rgbToAab(rgb, p), p);
}
export function jmhToRgb(JMh: number[], p: JMhParams): number[] {
  const hr = (JMh[2] * Math.PI) / 180;
  const A = jToAchromatic(JMh[0], p.inv_cz);
  const Aab = [A, JMh[1] * Math.cos(hr), JMh[1] * Math.sin(hr)];
  const cone = vmul(Aab, p.aabToCone).map(compressInv);
  return vmul(cone, p.camToRgb);
}

// ---- ODT params and tables ----
export interface ODTParams {
  peakLuminance: number;
  input: JMhParams;
  reach: JMhParams;
  limit: JMhParams;
  ts: TSParams;
  limit_J_max: number;
  model_gamma_inv: number;
  tableReachM: Float64Array;
  sat: number;
  sat_thr: number;
  compr: number;
  chroma_compress_scale: number;
  mid_J: number;
  focus_dist: number;
  lower_hull_gamma_inv: number;
  tableHues: Float64Array;
  /** [J, M, h] per entry. */
  tableGamutCusps: Float64Array;
  tableUpperHullGamma: Float64Array;
  hueLinearitySearchRange: [number, number];
}

function genUnitCubeCuspCorner(corner: number): number[] {
  return [
    (corner + 1) % CUSP_CORNER_COUNT < 3 ? 1 : 0,
    (corner + 5) % CUSP_CORNER_COUNT < 3 ? 1 : 0,
    (corner + 3) % CUSP_CORNER_COUNT < 3 ? 1 : 0,
  ];
}

function buildLimitingCuspCorners(params: JMhParams, peakLuminance: number): { rgb: number[][]; jmh: number[][] } {
  const tRgb: number[][] = [];
  const tJmh: number[][] = [];
  let minIndex = 0;
  for (let i = 0; i < CUSP_CORNER_COUNT; i++) {
    tRgb[i] = genUnitCubeCuspCorner(i).map((x) => (x * peakLuminance) / REF_LUMINANCE);
    tJmh[i] = rgbToJMh(tRgb[i], params);
    if (tJmh[i][2] < tJmh[minIndex][2]) minIndex = i;
  }
  const rgb: number[][] = new Array(TOTAL_CORNER_COUNT);
  const jmh: number[][] = new Array(TOTAL_CORNER_COUNT);
  for (let i = 0; i < CUSP_CORNER_COUNT; i++) {
    rgb[i + 1] = tRgb[(i + minIndex) % CUSP_CORNER_COUNT];
    jmh[i + 1] = tJmh[(i + minIndex) % CUSP_CORNER_COUNT];
  }
  rgb[0] = rgb[CUSP_CORNER_COUNT];
  rgb[CUSP_CORNER_COUNT + 1] = rgb[1];
  jmh[0] = [...jmh[CUSP_CORNER_COUNT]];
  jmh[CUSP_CORNER_COUNT + 1] = [...jmh[1]];
  jmh[0][2] -= HUE_LIMIT;
  jmh[CUSP_CORNER_COUNT + 1][2] += HUE_LIMIT;
  return { rgb, jmh };
}

function findReachCorners(params: JMhParams, p: { limit_J_max: number; ts: TSParams }): number[][] {
  const tJmh: number[][] = [];
  const limitA = jToAchromatic(p.limit_J_max, params.inv_cz);
  let minIndex = 0;
  for (let i = 0; i < CUSP_CORNER_COUNT; i++) {
    const v = genUnitCubeCuspCorner(i);
    let lower = 0;
    let upper = p.ts.forward_limit;
    while (upper - lower > REACH_CUSP_TOLERANCE) {
      const test = (lower + upper) / 2;
      const A = rgbToAab(v.map((x) => x * test), params)[0];
      if (A < limitA) lower = test;
      else upper = test;
    }
    tJmh[i] = rgbToJMh(v.map((x) => x * upper), params);
    if (tJmh[i][2] < tJmh[minIndex][2]) minIndex = i;
  }
  const jmh: number[][] = new Array(TOTAL_CORNER_COUNT);
  for (let i = 0; i < CUSP_CORNER_COUNT; i++) jmh[i + 1] = tJmh[(i + minIndex) % CUSP_CORNER_COUNT];
  jmh[0] = [...jmh[CUSP_CORNER_COUNT]];
  jmh[CUSP_CORNER_COUNT + 1] = [...jmh[1]];
  jmh[0][2] -= HUE_LIMIT;
  jmh[CUSP_CORNER_COUNT + 1][2] += HUE_LIMIT;
  return jmh;
}

function extractSortedCubeHues(reach: number[][], limit: number[][]): number[] {
  const sorted: number[] = [];
  let reachIdx = 1;
  let limitIdx = 1;
  while (reachIdx < CUSP_CORNER_COUNT + 1 || limitIdx < CUSP_CORNER_COUNT + 1) {
    // Past the end, the CTL reads the wrapped entry (hue + 360), which is
    // larger than any remaining hue of the other list.
    const reachHue = reach[reachIdx][2];
    const limitHue = limit[limitIdx][2];
    if (reachHue === limitHue) {
      sorted.push(reachHue);
      reachIdx++;
      limitIdx++;
    } else if (reachHue < limitHue) {
      sorted.push(reachHue);
      reachIdx++;
    } else {
      sorted.push(limitHue);
      limitIdx++;
    }
  }
  while (sorted.length < MAX_SORTED_CORNERS) sorted.push(0);
  return sorted;
}

function buildHueSampleInterval(samples: number, lower: number, upper: number, table: Float64Array, base: number): void {
  const delta = (upper - lower) / samples;
  for (let i = 0; i < samples; i++) table[base + i] = lower + i * delta;
}

function buildHueTable(sortedHues: number[]): Float64Array {
  const hueTable = new Float64Array(TOTAL_TABLE_SIZE);
  const idealSpacing = TABLE_SIZE / HUE_LIMIT;
  const samplesCount = new Array<number>(2 * CUSP_CORNER_COUNT + 2).fill(0);
  let lastIdx = 0;
  let minIndex = sortedHues[0] === 0 ? 0 : 1;
  for (let hueIdx = 0; hueIdx < MAX_SORTED_CORNERS; hueIdx++) {
    let nominalIdx = Math.min(Math.max(Math.round(sortedHues[hueIdx] * idealSpacing), minIndex), TABLE_SIZE - 1);
    if (lastIdx === nominalIdx) {
      if (hueIdx > 1 && samplesCount[hueIdx - 2] !== samplesCount[hueIdx - 1] - 1) {
        samplesCount[hueIdx - 1] = samplesCount[hueIdx - 1] - 1;
      } else {
        nominalIdx = nominalIdx + 1;
      }
    }
    samplesCount[hueIdx] = Math.min(nominalIdx, TABLE_SIZE - 1);
    minIndex = nominalIdx;
    lastIdx = minIndex;
  }
  let totalSamples = 0;
  let i = 0;
  buildHueSampleInterval(samplesCount[i], 0, sortedHues[i], hueTable, totalSamples + 1);
  totalSamples += samplesCount[i];
  for (i = i + 1; i < MAX_SORTED_CORNERS; i++) {
    const samples = samplesCount[i] - samplesCount[i - 1];
    buildHueSampleInterval(samples, sortedHues[i - 1], sortedHues[i], hueTable, totalSamples + 1);
    totalSamples += samples;
  }
  buildHueSampleInterval(TABLE_SIZE - totalSamples, sortedHues[i - 1], HUE_LIMIT, hueTable, totalSamples + 1);
  hueTable[0] = hueTable[BASE_INDEX + TABLE_SIZE - 1] - HUE_LIMIT;
  hueTable[BASE_INDEX + TABLE_SIZE] = hueTable[BASE_INDEX] + HUE_LIMIT;
  return hueTable;
}

function findDisplayCuspForHue(hue: number, rgbCorners: number[][], jmhCorners: number[][], params: JMhParams): [number, number] {
  let upperCorner = 1;
  for (let i = upperCorner; i < TOTAL_CORNER_COUNT; i++) {
    if (jmhCorners[i][2] > hue) {
      upperCorner = i;
      break;
    }
  }
  const lowerCorner = upperCorner - 1;
  if (jmhCorners[lowerCorner][2] === hue) return [jmhCorners[lowerCorner][0], jmhCorners[lowerCorner][1]];
  const lo = rgbCorners[lowerCorner];
  const hi = rgbCorners[upperCorner];
  let lowerT = 0;
  let upperT = 1;
  const at = (t: number) => [lerp(lo[0], hi[0], t), lerp(lo[1], hi[1], t), lerp(lo[2], hi[2], t)];
  while (upperT - lowerT > DISPLAY_CUSP_TOLERANCE) {
    const t = (lowerT + upperT) / 2;
    const JMh = rgbToJMh(at(t), params);
    if (JMh[2] < jmhCorners[lowerCorner][2]) upperT = t;
    else if (JMh[2] >= jmhCorners[upperCorner][2]) lowerT = t;
    else if (JMh[2] > hue) upperT = t;
    else lowerT = t;
  }
  const JMh = rgbToJMh(at((lowerT + upperT) / 2), params);
  return [JMh[0], JMh[1]];
}

function makeUniformHueGamutTable(reach: JMhParams, limit: JMhParams, p: { limit_J_max: number; ts: TSParams; peakLuminance: number }): Float64Array {
  const reachCorners = findReachCorners(reach, p);
  const { rgb, jmh } = buildLimitingCuspCorners(limit, p.peakLuminance);
  const hueTable = buildHueTable(extractSortedCubeHues(reachCorners, jmh));
  const out = new Float64Array(TOTAL_TABLE_SIZE * 3);
  for (let i = BASE_INDEX; i < TOTAL_TABLE_SIZE; i++) {
    const [J, M] = findDisplayCuspForHue(hueTable[i], rgb, jmh, limit);
    out[i * 3] = J;
    out[i * 3 + 1] = M * (1 + SMOOTH_M * SMOOTH_CUSPS);
    out[i * 3 + 2] = hueTable[i];
  }
  out[0] = out[TABLE_SIZE * 3];
  out[1] = out[TABLE_SIZE * 3 + 1];
  out[2] = hueTable[0];
  const e = (BASE_INDEX + TABLE_SIZE) * 3;
  out[e] = out[BASE_INDEX * 3];
  out[e + 1] = out[BASE_INDEX * 3 + 1];
  out[e + 2] = hueTable[BASE_INDEX + TABLE_SIZE];
  return out;
}

function makeReachMTable(params: JMhParams, limitJmax: number): Float64Array {
  const table = new Float64Array(TOTAL_TABLE_SIZE);
  const outside = (M: number, hue: number) => jmhToRgb([limitJmax, M, hue], params).some((x) => x < 0);
  for (let i = 0; i < TABLE_SIZE; i++) {
    const hue = (i * HUE_LIMIT) / TABLE_SIZE;
    const range = 50;
    const maximum = 1300;
    let low = 0;
    let high = low + range;
    let isOutside = false;
    while (!isOutside && high < maximum) {
      isOutside = outside(high, hue);
      if (!isOutside) {
        low = high;
        high = high + range;
      }
    }
    while (high - low > 1e-2) {
      const m = (high + low) / 2;
      if (outside(m, hue)) high = m;
      else low = m;
    }
    table[i + BASE_INDEX] = high;
  }
  table[0] = table[TABLE_SIZE];
  table[BASE_INDEX + TABLE_SIZE] = table[BASE_INDEX];
  return table;
}

// ---- gamut compression helpers (shared by the table build and the transform) ----
function computeFocusJ(cuspJ: number, midJ: number, limitJmax: number): number {
  return lerp(cuspJ, midJ, Math.min(1, CUSP_MID_BLEND - cuspJ / limitJmax));
}
function getFocusGain(J: number, analyticalThreshold: number, limitJmax: number, focusDist: number): number {
  let gain = limitJmax * focusDist;
  if (J > analyticalThreshold) {
    let adj = Math.log10((limitJmax - analyticalThreshold) / Math.max(0.0001, limitJmax - J));
    adj = adj * adj + 1;
    gain *= adj;
  }
  return gain;
}
function solveJIntersect(J: number, M: number, focusJ: number, maxJ: number, slopeGain: number): number {
  const Ms = M / slopeGain;
  const a = Ms / focusJ;
  if (J < focusJ) {
    const b = 1 - Ms;
    const c = -J;
    const root = Math.sqrt(b * b - 4 * a * c);
    return (-2 * c) / (b + root);
  }
  const b = -(1 + Ms + maxJ * a);
  const c = maxJ * Ms + J;
  const root = Math.sqrt(b * b - 4 * a * c);
  return (-2 * c) / (b - root);
}
function computeCompressionVectorSlope(intersectJ: number, focusJ: number, limitJmax: number, slopeGain: number): number {
  const dir = intersectJ < focusJ ? intersectJ : limitJmax - intersectJ;
  return (dir * (intersectJ - focusJ)) / (focusJ * slopeGain);
}
function sminScaled(a: number, b: number, ref: number): number {
  const s = SMOOTH_CUSPS * ref;
  const h = Math.max(s - Math.abs(a - b), 0) / s;
  return Math.min(a, b) - h * h * h * s * (1 / 6);
}
function estimateLineBoundaryM(Jaxis: number, slope: number, invGamma: number, Jmax: number, Mmax: number, Jref: number): number {
  const shifted = Jref * Math.pow(Jaxis / Jref, invGamma);
  return (shifted * Mmax) / (Jmax - slope * Mmax);
}
function findGamutBoundaryIntersection(cusp: number[], Jmax: number, gTopInv: number, gBottomInv: number, JiSource: number, slope: number, JiCusp: number): number {
  const lower = estimateLineBoundaryM(JiSource, slope, gBottomInv, cusp[0], cusp[1], JiCusp);
  const upper = estimateLineBoundaryM(Jmax - JiSource, -slope, gTopInv, Jmax - cusp[0], cusp[1], Jmax - JiCusp);
  return sminScaled(lower, upper, cusp[1]);
}

function makeUpperHullGammaTable(cusps: Float64Array, p: ODTParams): Float64Array {
  const out = new Float64Array(TOTAL_TABLE_SIZE);
  const testPositions = [0.01, 0.1, 0.5, 0.8, 0.99];
  const lumLimit = p.peakLuminance / REF_LUMINANCE;
  for (let i = BASE_INDEX; i < BASE_INDEX + TABLE_SIZE; i++) {
    const hue = cusps[i * 3 + 2];
    const cusp = [cusps[i * 3], cusps[i * 3 + 1]];
    const analyticalThreshold = lerp(cusp[0], p.limit_J_max, FOCUS_GAIN_BLEND);
    const focusJ = computeFocusJ(cusp[0], p.mid_J, p.limit_J_max);
    const tests = testPositions.map((pos) => {
      const testJ = lerp(cusp[0], p.limit_J_max, pos);
      const gain = getFocusGain(testJ, analyticalThreshold, p.limit_J_max, p.focus_dist);
      const Ji = solveJIntersect(testJ, cusp[1], focusJ, p.limit_J_max, gain);
      return {
        Ji,
        slope: computeCompressionVectorSlope(Ji, focusJ, p.limit_J_max, gain),
        Jcusp: solveJIntersect(cusp[0], cusp[1], focusJ, p.limit_J_max, gain),
      };
    });
    const fits = (gammaInv: number) => {
      for (const t of tests) {
        const M = findGamutBoundaryIntersection(cusp, p.limit_J_max, gammaInv, p.lower_hull_gamma_inv, t.Ji, t.slope, t.Jcusp);
        const J = t.Ji + t.slope * M;
        const rgb = jmhToRgb([J, M, hue], p.limit);
        if (!(rgb[0] > lumLimit || rgb[1] > lumLimit || rgb[2] > lumLimit)) return false;
      }
      return true;
    };
    let low = GAMMA_MINIMUM;
    let high = low + GAMMA_SEARCH_STEP;
    let found = false;
    while (!found && high < GAMMA_MAXIMUM) {
      if (!fits(1 / high)) {
        low = high;
        high += GAMMA_SEARCH_STEP;
      } else {
        found = true;
      }
    }
    while (high - low > GAMMA_ACCURACY) {
      const g = (high + low) / 2;
      if (fits(1 / g)) high = g;
      else low = g;
    }
    out[i] = 1 / high;
  }
  out[0] = out[TABLE_SIZE];
  out[TABLE_SIZE + BASE_INDEX] = out[BASE_INDEX];
  return out;
}

function determineHueLinearitySearchRange(hues: Float64Array): [number, number] {
  const r: [number, number] = [0, 1];
  for (let i = BASE_INDEX; i < BASE_INDEX + TABLE_SIZE; i++) {
    const delta = i - huePositionInUniformTable(hues[i], TOTAL_TABLE_SIZE);
    r[0] = Math.min(r[0], delta);
    r[1] = Math.max(r[1], delta + 1);
  }
  return r;
}

/** Precompute the ACES 2.0 output transform for a peak luminance (nits) and limiting primaries. */
export function initODTParams(peakLuminance: number, limitingPrimaries: Chromaticities): ODTParams {
  const ts = initTSParams(peakLuminance);
  const input = initJMhParams(AP0);
  const reach = initJMhParams(AP1);
  const limit = initJMhParams(limitingPrimaries);
  const limit_J_max = yToJ(peakLuminance, input);
  const p: ODTParams = {
    peakLuminance,
    input,
    reach,
    limit,
    ts,
    limit_J_max,
    model_gamma_inv: 1 / MODEL_GAMMA,
    tableReachM: makeReachMTable(reach, limit_J_max),
    sat: Math.max(0.2, CHROMA_EXPAND - CHROMA_EXPAND * CHROMA_EXPAND_FACT * ts.log_peak),
    sat_thr: CHROMA_EXPAND_THR / peakLuminance,
    compr: CHROMA_COMPRESS + CHROMA_COMPRESS * CHROMA_COMPRESS_FACT * ts.log_peak,
    chroma_compress_scale: Math.pow(0.03379 * peakLuminance, 0.30596) - 0.45135,
    mid_J: yToJ(ts.c_t * REF_LUMINANCE, input),
    focus_dist: FOCUS_DISTANCE + FOCUS_DISTANCE * FOCUS_DISTANCE_SCALING * ts.log_peak,
    lower_hull_gamma_inv: 1 / (1.14 + 0.07 * ts.log_peak),
    tableHues: new Float64Array(TOTAL_TABLE_SIZE),
    tableGamutCusps: new Float64Array(0),
    tableUpperHullGamma: new Float64Array(0),
    hueLinearitySearchRange: [0, 1],
  };
  p.tableGamutCusps = makeUniformHueGamutTable(reach, limit, p);
  for (let i = 0; i < TOTAL_TABLE_SIZE; i++) p.tableHues[i] = p.tableGamutCusps[i * 3 + 2];
  p.tableUpperHullGamma = makeUpperHullGammaTable(p.tableGamutCusps, p);
  p.hueLinearitySearchRange = determineHueLinearitySearchRange(p.tableHues);
  return p;
}

// ---- per-pixel forward transform (CPU reference of the GLSL in tonemap.ts) ----
function reachMFromTable(h: number, table: Float64Array): number {
  const base = huePositionInUniformTable(h, TABLE_SIZE);
  const t = h - base;
  return lerp(table[base + BASE_INDEX], table[base + BASE_INDEX + 1], t);
}
function toe(x: number, limit: number, k1In: number, k2In: number): number {
  if (x > limit) return x;
  const k2 = Math.max(k2In, 0.001);
  const k1 = Math.sqrt(k1In * k1In + k2 * k2);
  const k3 = (limit + k1) / (limit + k2);
  const minusB = k3 * x - k1;
  const minusC = k2 * k3 * x;
  return 0.5 * (minusB + Math.sqrt(minusB * minusB + 4 * minusC));
}
function chromaCompressNorm(h: number, scale: number): number {
  const hr = (h * Math.PI) / 180;
  const a = Math.cos(hr);
  const b = Math.sin(hr);
  const cos2 = a * a - b * b;
  const sin2 = 2 * a * b;
  const cos3 = 4 * a * a * a - 3 * a;
  const sin3 = 3 * b - 4 * b * b * b;
  const M = 11.34072 * a + 16.46899 * cos2 + 7.8838 * cos3 + 14.66441 * b + -6.37224 * sin2 + 9.19364 * sin3 + 77.12896;
  return M * scale;
}
function chromaCompressFwd(JMh: number[], tonemappedJ: number, p: ODTParams): number[] {
  const [J, M, h] = JMh;
  let Mc = M;
  if (M !== 0) {
    const nJ = tonemappedJ / p.limit_J_max;
    const snJ = Math.max(0, 1 - nJ);
    const Mnorm = chromaCompressNorm(h, p.chroma_compress_scale);
    const limit = (Math.pow(nJ, p.model_gamma_inv) * reachMFromTable(h, p.tableReachM)) / Mnorm;
    Mc = M * Math.pow(tonemappedJ / J, p.model_gamma_inv);
    Mc /= Mnorm;
    Mc = limit - toe(limit - Mc, limit - 0.001, snJ * p.sat, Math.sqrt(nJ * nJ + p.sat_thr));
    Mc = toe(Mc, limit, nJ * p.compr, snJ);
    Mc *= Mnorm;
  }
  return [tonemappedJ, Mc, h];
}
function cuspFromTable(h: number, table: Float64Array): number[] {
  let lowI = 0;
  let highI = BASE_INDEX + TABLE_SIZE;
  let i = huePositionInUniformTable(h, TABLE_SIZE) + BASE_INDEX;
  while (lowI + 1 < highI) {
    if (h > table[i * 3 + 2]) lowI = i;
    else highI = i;
    i = Math.trunc((lowI + highI) / 2);
  }
  const lo = highI - 1;
  const t = (h - table[lo * 3 + 2]) / (table[highI * 3 + 2] - table[lo * 3 + 2]);
  return [lerp(table[lo * 3], table[highI * 3], t), lerp(table[lo * 3 + 1], table[highI * 3 + 1], t)];
}
function lookupHueInterval(h: number, hues: Float64Array, range: [number, number]): number {
  let i = BASE_INDEX + huePositionInUniformTable(h, TOTAL_TABLE_SIZE);
  let iLo = Math.max(BASE_INDEX, i + range[0]);
  let iHi = Math.min(BASE_INDEX + TABLE_SIZE, i + range[1]);
  while (iLo + 1 < iHi) {
    if (h > hues[i]) iLo = i;
    else iHi = i;
    i = Math.trunc((iLo + iHi) / 2);
  }
  return Math.max(1, iHi);
}
function remapM(M: number, gamutM: number, reachM: number): number {
  const proportion = Math.max(gamutM / reachM, COMPRESSION_THRESHOLD);
  const threshold = proportion * gamutM;
  if (M <= threshold || proportion >= 1) return M;
  const mOffset = M - threshold;
  const gamutOffset = gamutM - threshold;
  const reachOffset = reachM - threshold;
  const scale = reachOffset / (reachOffset / gamutOffset - 1);
  const nd = mOffset / scale;
  return threshold + (scale * nd) / (1 + nd);
}
function gamutCompressFwd(JMh: number[], p: ODTParams): number[] {
  const [J, M, h] = JMh;
  if (J <= 0) return [0, 0, h];
  if (M < 0 || J > p.limit_J_max) return [J, 0, h];
  const iHi = lookupHueInterval(h, p.tableHues, p.hueLinearitySearchRange);
  const t = h - p.tableHues[iHi - 1];
  const cusp = cuspFromTable(h, p.tableGamutCusps);
  const gTopInv = lerp(p.tableUpperHullGamma[iHi - 1], p.tableUpperHullGamma[iHi], t);
  const focusJ = computeFocusJ(cusp[0], p.mid_J, p.limit_J_max);
  const analyticalThreshold = lerp(cusp[0], p.limit_J_max, FOCUS_GAIN_BLEND);

  const gain = getFocusGain(J, analyticalThreshold, p.limit_J_max, p.focus_dist);
  const JiSource = solveJIntersect(J, M, focusJ, p.limit_J_max, gain);
  const slope = computeCompressionVectorSlope(JiSource, focusJ, p.limit_J_max, gain);
  const JiCusp = solveJIntersect(cusp[0], cusp[1], focusJ, p.limit_J_max, gain);
  const gamutM = findGamutBoundaryIntersection(cusp, p.limit_J_max, gTopInv, p.lower_hull_gamma_inv, JiSource, slope, JiCusp);
  if (gamutM <= 0) return [J, 0, h];
  const reachMax = reachMFromTable(h, p.tableReachM);
  const reachM = estimateLineBoundaryM(JiSource, slope, p.model_gamma_inv, p.limit_J_max, reachMax, p.limit_J_max);
  const Mr = remapM(M, gamutM, reachM);
  return [JiSource + Mr * slope, Mr, h];
}

/** ACES2065-1 (AP0) in, limiting-primaries display-linear RGB out (1.0 = 100 nits), clamped to the peak. */
export function outputTransformFwd(aces: number[], p: ODTParams): number[] {
  const AP0_TO_AP1 = mul33(rgbToXyz(AP0), xyzToRgb(AP1));
  const AP1_TO_AP0 = inv33(AP0_TO_AP1);
  const ap1 = vmul(aces, AP0_TO_AP1).map((x) => Math.min(Math.max(x, 0), p.ts.forward_limit));
  const JMh = rgbToJMh(vmul(ap1, AP1_TO_AP0), p.input);
  const linear = jToY(JMh[0], p.input) / REF_LUMINANCE;
  const Jts = yToJ(tonescaleFwd(linear, p.ts), p.input);
  const tc = chromaCompressFwd(JMh, Jts, p);
  const gc = gamutCompressFwd(tc, p);
  const peak = p.peakLuminance / REF_LUMINANCE;
  return jmhToRgb(gc, p.limit).map((x) => Math.min(Math.max(x, 0), peak));
}

/** sRGB piecewise inverse EOTF (IEC 61966-2-1). */
export function srgbEncode(x: number): number {
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}
