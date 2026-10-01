// Assembles a final GLSL ES 3.00 shader from a hand-ported template plus a
// parsed .brdf. Reproduces BRDFBase::loadShaderFromFile token replacement
// (sample/brdf-main/src/brdf/BRDFBase.cpp:336-378):
//
//   ::INSERT_UNIFORMS_HERE::      -> one `uniform <type> <name>;` per parameter
//   ::INSERT_BRDF_FUNCTION_HERE:: -> the .brdf shader body, verbatim
//   ::INSERT_IS_FUNCTION_HERE::   -> the .brdf isFunc body (empty in this milestone)
//
// The templates under public/shaderTemplates/ are already authored as
// `#version 300 es`, so no #version rewriting happens here. The user's BRDF
// body is injected almost unchanged. A small compatibility pass renames user
// functions that collide with GLSL ES built-ins (for example `reflect`) because
// WebGL2 rejects redeclaring them even though the original desktop path accepted
// some of these samples.

import type { BrdfDef, ParamDef, TextureChannel } from './types.js';

/** How one textured parameter is read in the shader (see textureFetches). */
export interface TextureBinding {
  name: string;
  channel: TextureChannel;
  convert: 'none' | 'toLinear' | 'toSrgb';
}
import { MITER_GLSL } from '../gl/line-expansion.js';

export function uniformDecls(params: ParamDef[], bindings: readonly TextureBinding[] = []): string {
  const textured = new Set(bindings.map((b) => b.name));
  const out: string[] = [];
  // Order mirrors the original: floats, then bools, then colors. A textured
  // parameter becomes a sampler plus a plain global of the same name, filled
  // per pixel by ::INSERT_TEXTURE_FETCH_HERE:: (so the .brdf body is unchanged).
  const decl = (type: string, name: string) =>
    textured.has(name) ? `uniform sampler2D ${textureUniform(name)};\n${type} ${name};` : `uniform ${type} ${name};`;
  for (const p of params) if (p.kind === 'float') out.push(decl('float', p.name));
  for (const p of params) if (p.kind === 'bool') out.push(`uniform bool ${p.name};`);
  for (const p of params) if (p.kind === 'color') out.push(decl('vec3', p.name));
  if (bindings.length) out.push(TEXTURE_HELPERS);
  return out.join('\n');
}

const TEXTURE_HELPERS = `vec3 brdfTexSrgbToLinear(vec3 c) { c = max(c, vec3(0.0)); return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
vec3 brdfTexLinearToSrgb(vec3 c) { c = max(c, vec3(0.0)); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }`;

/** Sampler uniform name for a textured parameter. */
export function textureUniform(name: string): string {
  return `brdfTex_${name}`;
}

function textureFetches(params: ParamDef[], bindings: readonly TextureBinding[]): string {
  const out: string[] = [];
  for (const b of bindings) {
    const p = params.find((x) => x.name === b.name);
    if (!p || p.kind === 'bool') continue;
    const sample = `texture(${textureUniform(b.name)}, vUV)`;
    const rgb = p.kind === 'color' ? `${sample}.rgb` : `vec3(${sample}.${b.channel === 'rgb' ? 'r' : b.channel})`;
    const conv =
      b.convert === 'toLinear' ? `brdfTexSrgbToLinear(${rgb})` : b.convert === 'toSrgb' ? `brdfTexLinearToSrgb(${rgb})` : rgb;
    out.push(`${b.name} = ${p.kind === 'color' ? conv : `(${conv}).x`};`);
  }
  return out.join('\n    ');
}

/**
 * Promote bare integer literals to float (`1` -> `1.0`) in user GLSL.
 *
 * Desktop GLSL 410 implicitly converts int literals to float in mixed
 * expressions (e.g. disney.brdf's `1 - u`, `a >= 1`, `1/PI`, `2 * LdotH`);
 * GLSL ES 3.00 does not. We promote standalone integer literals while leaving:
 *   - array subscripts (`x[0]`, `Cdlin[2]`)  -> not preceded by `[`
 *   - identifiers / existing floats (`vec3`, `2.2`, `.08`, `GTR1`)
 *   - scientific notation exponents (`1e-20`)
 *
 * Limitation: this is a lexical pass, not a parser. Integer literals that must
 * remain int (e.g. `for (int i = 0; ...)` counters, texelFetch indices) would
 * be wrongly promoted. The bundled analytic .brdf files don't use those; revisit
 * for measured BRDFs.
 */
export function promoteIntLiterals(src: string): string {
  return src.replace(/(?<![\w.[])(\d+)(?![\w.])/g, (match, digits: string, offset: number, full: string) => {
    if (/[eE][+-]?$/.test(full.slice(Math.max(0, offset - 2), offset))) return match;
    return `${digits}.0`;
  });
}

/**
 * Rename user-defined functions that collide with GLSL ES built-ins.
 *
 * The source .brdf files are left untouched. This only changes the transient
 * shader string injected into WebGL templates. Keep this deliberately narrow:
 * only rename a built-in when this BRDF actually declares that function.
 */
export function escapeBuiltinFunctionRedeclarations(src: string): string {
  const builtins = ['reflect'];
  let out = src;
  for (const name of builtins) {
    const declaration = new RegExp(`\\b(?:float|vec[234]|mat[234]|bool|int)\\s+${name}\\s*\\(`);
    if (!declaration.test(out)) continue;
    out = out.replace(new RegExp(`\\b${name}\\s*\\(`, 'g'), `brdf_${name}(`);
  }
  return out;
}

/**
 * `bindings` (Lit Object only): parameters read from images. The template must
 * then provide `in vec2 vUV` and the ::INSERT_TEXTURE_FETCH_HERE:: marker.
 */
export function injectTemplate(template: string, def: BrdfDef, bindings: readonly TextureBinding[] = []): string {
  const uniforms = uniformDecls(def.params, bindings);
  const compat = (s: string) => escapeBuiltinFunctionRedeclarations(s);
  const promote = (s: string) => (def.noPromote ? compat(s) : promoteIntLiterals(compat(s)));
  const brdf = `\n${promote(def.shaderSource)}\n`;
  const isFunc = def.isFuncSource ? `\n${promote(def.isFuncSource)}\n` : '';
  return template
    .split('::INSERT_UNIFORMS_HERE::')
    .join(uniforms)
    .split('::INSERT_BRDF_FUNCTION_HERE::')
    .join(brdf)
    .split('::INSERT_IS_FUNCTION_HERE::')
    .join(isFunc)
    .split('::INSERT_MITER_HERE::')
    .join(MITER_GLSL)
    .split('::INSERT_TEXTURE_FETCH_HERE::')
    .join(textureFetches(def.params, bindings));
}

const templateCache = new Map<string, Promise<string>>();

/** Fetch a shader template from public/shaderTemplates/, honoring the Vite base path. */
export function loadTemplate(file: string): Promise<string> {
  let p = templateCache.get(file);
  if (!p) {
    const url = `${import.meta.env.BASE_URL}shaderTemplates/${file}`;
    // no-cache so an edited shader template is never served stale during dev.
    p = fetch(url, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`failed to load shader template ${file}: ${r.status}`);
      return r.text();
    });
    templateCache.set(file, p);
  }
  return p;
}
