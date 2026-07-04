// Uploads a parsed HDR equirectangular image as an RGBA32F texture for IBL.
// Linear filtering needs OES_texture_float_linear; without it we fall back to
// NEAREST (blockier env, but still functional).

import type { HdrImage } from '../io/hdr.js';

export interface EnvTexture {
  texture: WebGLTexture;
  conditionalCdf: WebGLTexture;
  marginalCdf: WebGLTexture;
  width: number;
  height: number;
  linear: boolean;
  totalWeight: number;
}

export function uploadEnv(gl: WebGL2RenderingContext, img: HdrImage): EnvTexture {
  const linear = !!gl.getExtension('OES_texture_float_linear');
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const filter = linear ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  // Wrap horizontally (longitude), clamp vertically (latitude poles).
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, img.width, img.height, 0, gl.RGBA, gl.FLOAT, img.data);

  const sampling = buildEnvSamplingTables(img);
  const conditionalCdf = uploadR32F(gl, img.width, img.height, sampling.conditionalCdf);
  const marginalCdf = uploadR32F(gl, 1, img.height, sampling.marginalCdf);
  return {
    texture: tex,
    conditionalCdf,
    marginalCdf,
    width: img.width,
    height: img.height,
    linear,
    totalWeight: sampling.totalWeight,
  };
}

function buildEnvSamplingTables(img: HdrImage): {
  conditionalCdf: Float32Array;
  marginalCdf: Float32Array;
  totalWeight: number;
} {
  const { width, height, data } = img;
  const conditionalCdf = new Float32Array(width * height);
  const marginalCdf = new Float32Array(height);
  const rowWeights = new Float64Array(height);
  let totalWeight = 0;

  for (let y = 0; y < height; y++) {
    const sinTheta = Math.sin(Math.PI * (y + 0.5) / height);
    let rowWeight = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = finiteNonNegative(data[i]);
      const g = finiteNonNegative(data[i + 1]);
      const b = finiteNonNegative(data[i + 2]);
      const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;
      rowWeight += luminance * sinTheta;
      conditionalCdf[y * width + x] = rowWeight;
    }

    rowWeights[y] = rowWeight;
    totalWeight += rowWeight;
    if (rowWeight > 0) {
      const inv = 1 / rowWeight;
      for (let x = 0; x < width; x++) conditionalCdf[y * width + x] *= inv;
      conditionalCdf[y * width + width - 1] = 1;
    } else {
      for (let x = 0; x < width; x++) conditionalCdf[y * width + x] = (x + 1) / width;
    }
  }

  if (totalWeight > 0) {
    let c = 0;
    const inv = 1 / totalWeight;
    for (let y = 0; y < height; y++) {
      c += rowWeights[y];
      marginalCdf[y] = c * inv;
    }
    marginalCdf[height - 1] = 1;
  } else {
    for (let y = 0; y < height; y++) marginalCdf[y] = (y + 1) / height;
  }

  return { conditionalCdf, marginalCdf, totalWeight };
}

function finiteNonNegative(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function uploadR32F(gl: WebGL2RenderingContext, width: number, height: number, data: Float32Array): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, data);
  return tex;
}
