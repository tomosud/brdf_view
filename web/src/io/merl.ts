// MERL .binary measured-BRDF loader. Format (Matusik et al., as read by
// BRDFMeasuredMERL::loadMERLData): three int32 dims, then 3*N float64 values
// laid out as R block, G block, B block. N = dims[0]*dims[1]*dims[2]
// (90*90*180 = 1,458,000 for the standard isotropic resolution).

import type { MeasuredData } from '../brdf/types.js';

// Texture packing width. Must match TEX_W in the measured BRDF shader.
export const MEASURED_TEX_WIDTH = 4096;

export function parseMerl(buf: ArrayBuffer): MeasuredData {
  const view = new DataView(buf);
  const d0 = view.getInt32(0, true);
  const d1 = view.getInt32(4, true);
  const d2 = view.getInt32(8, true);
  const n = d0 * d1 * d2;
  const total = 3 * n;
  const expected = 12 + total * 8;
  if (n <= 0 || buf.byteLength !== expected) {
    throw new Error(
      `not a valid MERL .binary (dims ${d0}x${d1}x${d2}, size ${buf.byteLength}, expected ${expected})`,
    );
  }

  const texWidth = MEASURED_TEX_WIDTH;
  const texHeight = Math.ceil(total / texWidth);

  // double -> float, preserving R/G/B block order. Sized to the full texture
  // (trailing padding is never indexed by the shader).
  const data = new Float32Array(texWidth * texHeight);
  let off = 12;
  for (let i = 0; i < total; i++, off += 8) {
    data[i] = view.getFloat64(off, true);
  }

  return { data, texWidth, texHeight };
}
