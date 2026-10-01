// Shared helper: loads a vert/frag template pair, then builds and caches a
// linked program per BrdfDef (injecting the BRDF body), and applies a BRDF
// instance's parameter values as uniforms. Used by every BRDF view.

import { buildProgram, Uniforms, ShaderError } from './renderer.js';
import { injectTemplate, loadTemplate, textureUniform, type TextureBinding } from '../brdf/shader-builder.js';
import type { BrdfDef, BrdfInstance, TextureImage } from '../brdf/types.js';

/**
 * Texture units: 0 measured data, 1-3 Lit Object environment, 4 normal map,
 * 5-12 parameter images, 13 display tone map tables (src/gl/tonemap.ts),
 * 14-15 Lit Object occlusion BVH (nodes, triangles).
 */
export const NORMAL_MAP_UNIT = 4;
export const BVH_NODE_UNIT = 14;
export const BVH_TRI_UNIT = 15;
const PARAM_TEXTURE_UNIT = 5;

export interface BrdfProgram {
  program: WebGLProgram;
  u: Uniforms;
  posLoc: number;
}

export class BrdfProgramCache {
  private templates: { vert: string; frag: string } | null = null;
  /** Per BRDF: one program per set of textured parameters ('' = none). */
  private programs = new Map<BrdfDef, Map<string, BrdfProgram | 'error'>>();
  private textures = new Map<BrdfDef, WebGLTexture>();
  private imageTextures = new WeakMap<HTMLImageElement, WebGLTexture>();
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

  /**
   * Linked program for a BRDF (built and cached lazily). null on compile error.
   * `bindings` lists parameters read from images (templates with vUV only).
   */
  get(def: BrdfDef, bindings: readonly TextureBinding[] = []): BrdfProgram | null {
    const key = bindings
      .map((b) => `${b.name}:${b.channel}:${b.convert}`)
      .sort()
      .join(',');
    let variants = this.programs.get(def);
    if (!variants) {
      variants = new Map();
      this.programs.set(def, variants);
    }
    const cached = variants.get(key);
    if (cached) return cached === 'error' ? null : cached;
    if (!this.templates) return null;
    const gl = this.gl;
    try {
      const program = buildProgram(
        gl,
        injectTemplate(this.templates.vert, def, bindings),
        injectTemplate(this.templates.frag, def, bindings),
        `${this.label}:${def.name}${key ? ` [textures: ${key}]` : ''}`,
      );
      const rec: BrdfProgram = {
        program,
        u: new Uniforms(gl, program),
        posLoc: gl.getAttribLocation(program, 'vtx_position'),
      };
      variants.set(key, rec);
      return rec;
    } catch (e) {
      variants.set(key, 'error');
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

  /** Bind an image (uploaded once per context) to a texture unit. */
  bindImage(unit: number, tex: TextureImage): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.ensureImageTexture(tex));
  }

  /** Upload (once per context) an image as an RGBA8 texture with mipmaps; values stay raw. */
  private ensureImageTexture(tex: TextureImage): WebGLTexture {
    let t = this.imageTextures.get(tex.image);
    if (t) return t;
    const gl = this.gl;
    t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    // OBJ UVs have v = 0 at the bottom; keep the raw pixel values (no color management).
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, tex.image);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    this.imageTextures.set(tex.image, t);
    return t;
  }

  /** Set the BRDF's float/bool/color parameter uniforms from its current values. */
  applyParams(u: Uniforms, inst: BrdfInstance, bindings: readonly TextureBinding[] = []): void {
    const textured = bindings.map((b) => b.name);
    textured.forEach((name, i) => {
      const tex = inst.textures?.get(name);
      if (!tex) return;
      this.bindImage(PARAM_TEXTURE_UNIT + i, tex);
      u.i(textureUniform(name), PARAM_TEXTURE_UNIT + i);
    });
    if (inst.def.measured) {
      const tex = this.ensureTexture(inst.def);
      if (tex) {
        this.gl.activeTexture(this.gl.TEXTURE0);
        this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
        u.i('measuredData', 0);
      }
    }
    for (const p of inst.def.params) {
      if (textured.includes(p.name)) continue;
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

/** Shader compile/link errors seen so far (exposed as window.brdfView.errors()). */
export const shaderErrors: string[] = [];

export function reportShaderError(name: string, e: ShaderError): void {
  shaderErrors.push(`${name}: ${e.infoLog}`);
  console.error(`[shader] ${name}\n${e.infoLog}`);
  const el = document.getElementById('shader-log');
  if (el) {
    el.textContent = `${name}: ${e.infoLog}`;
    el.removeAttribute('hidden');
  }
}
