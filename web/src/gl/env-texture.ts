// Uploads a parsed HDR equirectangular image as an RGBA32F texture for IBL.
// Linear filtering needs OES_texture_float_linear; without it we fall back to
// NEAREST (blockier env, but still functional).

import type { HdrImage } from '../io/hdr.js';

export interface EnvTexture {
  texture: WebGLTexture;
  width: number;
  height: number;
  linear: boolean;
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
  return { texture: tex, width: img.width, height: img.height, linear };
}
