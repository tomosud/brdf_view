// Minimal WebGL2 plumbing: context creation, feature detection, shader
// compile/link with readable logs, a uniform-location cache, and DPR-aware
// canvas sizing. Intentionally thin — no scene-graph abstraction, so .brdf
// GLSL fragments flow into shaders unchanged.

export interface FeatureReport {
  ok: boolean;
  missing: string[];
  details: Record<string, string | number | boolean>;
}

/** Probe required WebGL2 features for the analytic-core milestone. */
export function detectFeatures(gl: WebGL2RenderingContext): FeatureReport {
  const missing: string[] = [];
  const details: Record<string, string | number | boolean> = {};

  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  details.MAX_TEXTURE_SIZE = maxTex;
  if (maxTex < 2048) missing.push('MAX_TEXTURE_SIZE >= 2048');

  const vertHigh = gl.getShaderPrecisionFormat(gl.VERTEX_SHADER, gl.HIGH_FLOAT);
  const fragHigh = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  details.vertexHighpFloat = !!vertHigh && vertHigh.precision > 0;
  details.fragmentHighpFloat = !!fragHigh && fragHigh.precision > 0;
  if (!fragHigh || fragHigh.precision === 0) missing.push('fragment highp float precision');

  // NOTE: float render targets (EXT_color_buffer_float) and OES_texture_float_linear
  // are required only for the later IBL milestone, not here.

  return { ok: missing.length === 0, missing, details };
}

export interface ProgramInfo {
  program: WebGLProgram;
  log: string;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string, label: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('createShader failed');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(sh) ?? '(no log)';
    gl.deleteShader(sh);
    throw new ShaderError(`${label} compile failed`, info, src);
  }
  return sh;
}

export class ShaderError extends Error {
  constructor(message: string, public readonly infoLog: string, public readonly source: string) {
    super(`${message}\n${infoLog}`);
    this.name = 'ShaderError';
  }
}

export function buildProgram(
  gl: WebGL2RenderingContext,
  vertSrc: string,
  fragSrc: string,
  label = 'program',
): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vertSrc, `${label}.vert`);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc, `${label}.frag`);
  const program = gl.createProgram();
  if (!program) throw new Error('createProgram failed');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program) ?? '(no log)';
    gl.deleteProgram(program);
    throw new ShaderError(`${label} link failed`, info, `${vertSrc}\n/* --- */\n${fragSrc}`);
  }
  return program;
}

/** Caches uniform locations for one program and exposes typed setters. */
export class Uniforms {
  private cache = new Map<string, WebGLUniformLocation | null>();
  constructor(private gl: WebGL2RenderingContext, private program: WebGLProgram) {}

  loc(name: string): WebGLUniformLocation | null {
    let l = this.cache.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.program, name);
      this.cache.set(name, l);
    }
    return l;
  }

  f(name: string, v: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform1f(l, v);
  }
  i(name: string, v: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform1i(l, v);
  }
  v2(name: string, x: number, y: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform2f(l, x, y);
  }
  v3(name: string, x: number, y: number, z: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform3f(l, x, y, z);
  }
  m4(name: string, m: Float32Array): void {
    const l = this.loc(name);
    if (l) this.gl.uniformMatrix4fv(l, false, m);
  }
}

/**
 * Resize a canvas to its CSS box times devicePixelRatio. Returns true if the
 * backing store size changed (caller should reset the viewport).
 */
export function resizeToDisplay(canvas: HTMLCanvasElement, dpr = window.devicePixelRatio || 1): boolean {
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}
