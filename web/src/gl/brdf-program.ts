// Shared helper: loads a vert/frag template pair, then builds and caches a
// linked program per BrdfDef (injecting the BRDF body), and applies a BRDF
// instance's parameter values as uniforms. Used by every BRDF view.

import { buildProgram, Uniforms, ShaderError } from './renderer.js';
import { injectTemplate, loadTemplate } from '../brdf/shader-builder.js';
import type { BrdfDef, BrdfInstance } from '../brdf/types.js';

export interface BrdfProgram {
  program: WebGLProgram;
  u: Uniforms;
  posLoc: number;
}

export class BrdfProgramCache {
  private templates: { vert: string; frag: string } | null = null;
  private programs = new Map<BrdfDef, BrdfProgram | 'error'>();
  private textures = new Map<BrdfDef, WebGLTexture>();
  readonly ready: Promise<void>;

  constructor(
    private gl: WebGL2RenderingContext,
    vertFile: string,
    fragFile: string,
    private label: string,
  ) {
    this.ready = Promise.all([loadTemplate(vertFile), loadTemplate(fragFile)]).then(([vert, frag]) => {
      this.templates = { vert, frag };
    });
  }

  /** Linked program for a BRDF (built and cached lazily). null on compile error. */
  get(def: BrdfDef): BrdfProgram | null {
    const cached = this.programs.get(def);
    if (cached) return cached === 'error' ? null : cached;
    if (!this.templates) return null;
    const gl = this.gl;
    try {
      const program = buildProgram(
        gl,
        injectTemplate(this.templates.vert, def),
        injectTemplate(this.templates.frag, def),
        `${this.label}:${def.name}`,
      );
      const rec: BrdfProgram = {
        program,
        u: new Uniforms(gl, program),
        posLoc: gl.getAttribLocation(program, 'vtx_position'),
      };
      this.programs.set(def, rec);
      return rec;
    } catch (e) {
      this.programs.set(def, 'error');
      if (e instanceof ShaderError) reportShaderError(`${this.label}:${def.name}`, e);
      else console.error(e);
      return null;
    }
  }

  /** Upload (once per context) the measured BRDF data as an R32F texture. */
  private ensureTexture(def: BrdfDef): WebGLTexture | null {
    if (!def.measured) return null;
    let tex = this.textures.get(def);
    if (tex) return tex;
    const gl = this.gl;
    tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.R32F,
      def.measured.texWidth, def.measured.texHeight, 0,
      gl.RED, gl.FLOAT, def.measured.data,
    );
    this.textures.set(def, tex);
    return tex;
  }

  /** Set the BRDF's float/bool/color parameter uniforms from its current values. */
  applyParams(u: Uniforms, inst: BrdfInstance): void {
    if (inst.def.measured) {
      const tex = this.ensureTexture(inst.def);
      if (tex) {
        this.gl.activeTexture(this.gl.TEXTURE0);
        this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
        u.i('measuredData', 0);
      }
    }
    for (const p of inst.def.params) {
      const v = inst.values.get(p.name);
      if (p.kind === 'float') u.f(p.name, typeof v === 'number' ? v : p.default);
      else if (p.kind === 'bool') u.i(p.name, v ? 1 : 0);
      else {
        const c = (v as [number, number, number]) ?? p.default;
        u.v3(p.name, c[0], c[1], c[2]);
      }
    }
  }
}

export function reportShaderError(name: string, e: ShaderError): void {
  console.error(`[shader] ${name}\n${e.infoLog}`);
  const el = document.getElementById('shader-log');
  if (el) {
    el.textContent = `${name}: ${e.infoLog}`;
    el.removeAttribute('hidden');
  }
}
