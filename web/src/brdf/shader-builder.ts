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
// body is injected unchanged; conversion of any GLSL 410-isms in user code is a
// deliberate non-goal (the bundled sample .brdf files are ES-compatible GLSL).

import type { BrdfDef, ParamDef } from './types.js';
import { MITER_GLSL } from '../gl/line-expansion.js';

export function uniformDecls(params: ParamDef[]): string {
  const out: string[] = [];
  // Order mirrors the original: floats, then bools, then colors.
  for (const p of params) if (p.kind === 'float') out.push(`uniform float ${p.name};`);
  for (const p of params) if (p.kind === 'bool') out.push(`uniform bool ${p.name};`);
  for (const p of params) if (p.kind === 'color') out.push(`uniform vec3 ${p.name};`);
  return out.join('\n');
}

/**
 * Promote bare integer literals to float (`1` -> `1.0`) in user GLSL.
 *
 * Desktop GLSL 410 implicitly converts int literals to float in mixed
 * expressions (e.g. disney.brdf's `1 - u`, `a >= 1`, `1/PI`, `2 * LdotH`);
 * GLSL ES 3.00 does not. We promote standalone integer literals while leaving:
 *   - array subscripts (`x[0]`, `Cdlin[2]`)  -> not preceded by `[`
 *   - identifiers / existing floats (`vec3`, `2.2`, `.08`, `GTR1`)
 *
 * Limitation: this is a lexical pass, not a parser. Integer literals that must
 * remain int (e.g. `for (int i = 0; ...)` counters, texelFetch indices) would
 * be wrongly promoted. The bundled analytic .brdf files don't use those; revisit
 * for measured BRDFs.
 */
export function promoteIntLiterals(src: string): string {
  return src.replace(/(?<![\w.[])(\d+)(?![\w.])/g, '$1.0');
}

export function injectTemplate(template: string, def: BrdfDef): string {
  const uniforms = uniformDecls(def.params);
  const brdf = `\n${promoteIntLiterals(def.shaderSource)}\n`;
  const isFunc = def.isFuncSource ? `\n${promoteIntLiterals(def.isFuncSource)}\n` : '';
  return template
    .split('::INSERT_UNIFORMS_HERE::')
    .join(uniforms)
    .split('::INSERT_BRDF_FUNCTION_HERE::')
    .join(brdf)
    .split('::INSERT_IS_FUNCTION_HERE::')
    .join(isFunc)
    .split('::INSERT_MITER_HERE::')
    .join(MITER_GLSL);
}

const templateCache = new Map<string, Promise<string>>();

/** Fetch a shader template from public/shaderTemplates/, honoring the Vite base path. */
export function loadTemplate(file: string): Promise<string> {
  let p = templateCache.get(file);
  if (!p) {
    const url = `${import.meta.env.BASE_URL}shaderTemplates/${file}`;
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`failed to load shader template ${file}: ${r.status}`);
      return r.text();
    });
    templateCache.set(file, p);
  }
  return p;
}
