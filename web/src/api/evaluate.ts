// Numeric BRDF evaluation on the GPU for window.brdfView.evaluate / exportData.
// Uses its own offscreen WebGL2 context and the evaluate.vert/.frag templates:
// the .brdf GLSL is injected exactly as for the display views, and each sample
// is written to one RGBA32F texel (raw BRDF RGB, no clamping or tone mapping).

import { BrdfProgramCache } from '../gl/brdf-program.js';
import type { BrdfInstance } from '../brdf/types.js';

export type Vec3 = [number, number, number];

/** One evaluation point. N/X/Y default to the views' local frame (0,0,1)/(1,0,0)/(0,1,0). */
export interface EvalSample {
  L: Vec3;
  V: Vec3;
  N?: Vec3;
  X?: Vec3;
  Y?: Vec3;
}

const DEFAULT_N: Vec3 = [0, 0, 1];
const DEFAULT_X: Vec3 = [1, 0, 0];
const DEFAULT_Y: Vec3 = [0, 1, 0];

export class BrdfEvaluator {
  private readonly gl: WebGL2RenderingContext;
  private readonly cache: BrdfProgramCache;
  private readonly vao: WebGLVertexArrayObject;
  private readonly maxTex: number;

  constructor() {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const gl = canvas.getContext('webgl2', { antialias: false });
    if (!gl) throw new Error('evaluate: WebGL2 context creation failed');
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('evaluate: EXT_color_buffer_float is required for float readback');
    }
    this.gl = gl;
    this.maxTex = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
    this.vao = gl.createVertexArray()!;
    this.cache = new BrdfProgramCache(gl, 'evaluate.vert', 'evaluate.frag', 'Evaluate');
  }

  /** Evaluate BRDF(L, V, N, X, Y) for every sample. Returns packed RGB (3 floats per sample). */
  async evaluate(inst: BrdfInstance, samples: EvalSample[]): Promise<Float32Array> {
    await this.cache.ready;
    const prog = this.cache.get(inst.def);
    if (!prog) throw new Error(`evaluate: shader for "${inst.def.name}" failed to compile (see errors())`);
    const out = new Float32Array(samples.length * 3);
    // Keep the input texture height (5 blocks of `rows`) within MAX_TEXTURE_SIZE.
    const width = this.maxTex;
    const maxRows = Math.max(1, Math.floor(this.maxTex / 5));
    const chunk = width * maxRows;
    for (let start = 0; start < samples.length; start += chunk) {
      const part = samples.slice(start, start + chunk);
      out.set(this.evaluateChunk(prog, inst, part), start * 3);
    }
    return out;
  }

  private evaluateChunk(
    prog: NonNullable<ReturnType<BrdfProgramCache['get']>>,
    inst: BrdfInstance,
    samples: EvalSample[],
  ): Float32Array {
    const gl = this.gl;
    const n = samples.length;
    const width = Math.max(1, Math.min(n, this.maxTex));
    const rows = Math.max(1, Math.ceil(n / width));

    const input = new Float32Array(width * rows * 5 * 4);
    samples.forEach((s, i) => {
      const x = i % width;
      const y = Math.floor(i / width);
      const vecs = [s.L, s.V, s.N ?? DEFAULT_N, s.X ?? DEFAULT_X, s.Y ?? DEFAULT_Y];
      vecs.forEach((v, k) => {
        const u = normalize(v);
        const o = ((y + k * rows) * width + x) * 4;
        input[o] = u[0];
        input[o + 1] = u[1];
        input[o + 2] = u[2];
        input[o + 3] = 1;
      });
    });

    const inTex = makeTexture(gl, width, rows * 5, input);
    const outTex = makeTexture(gl, width, rows, null);
    const fb = gl.createFramebuffer()!;
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTex, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`evaluate: framebuffer incomplete (${status})`);
      gl.viewport(0, 0, width, rows);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.useProgram(prog.program);
      this.cache.applyParams(prog.u, inst); // measured BRDF data (if any) goes to unit 0
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, inTex);
      prog.u.i('evalInput', 1);
      prog.u.i('evalRows', rows);
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);

      const pixels = new Float32Array(width * rows * 4);
      gl.readPixels(0, 0, width, rows, gl.RGBA, gl.FLOAT, pixels);
      const out = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        out[i * 3] = pixels[i * 4];
        out[i * 3 + 1] = pixels[i * 4 + 1];
        out[i * 3 + 2] = pixels[i * 4 + 2];
      }
      return out;
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      gl.deleteTexture(inTex);
      gl.deleteTexture(outTex);
    }
  }
}

function makeTexture(gl: WebGL2RenderingContext, w: number, h: number, data: Float32Array | null): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
  return tex;
}

export function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
}
