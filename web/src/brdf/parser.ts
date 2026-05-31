// .brdf parser. Mirrors the section grammar consumed by BRDFBase::loadBRDF
// (sample/brdf-main/src/brdf/BRDFBase.cpp:110-300):
//
//   analytic
//   ::begin parameters
//   float <name> <min> <max> <default>
//   bool  <name> <default>
//   color <name> <r> <g> <b>
//   ::end parameters
//   ::begin shader   ... GLSL defining vec3 BRDF(...) ...   ::end shader
//   ::begin isFunc   ... GLSL importance-sampling fragment ...   ::end isFunc   (optional)
//
// The shader / isFunc bodies are preserved verbatim (no reformatting) so the
// user's GLSL is injected unchanged, matching the original design.

import type { BrdfDef, ParamDef } from './types.js';

function stripComment(line: string): string {
  // The original format uses '#' line comments inside the parameters block.
  const hash = line.indexOf('#');
  return hash >= 0 ? line.slice(0, hash) : line;
}

function parseParam(line: string): ParamDef | null {
  const t = line.trim().split(/\s+/);
  if (t.length === 0 || t[0] === '') return null;
  switch (t[0]) {
    case 'float':
      return { kind: 'float', name: t[1], min: Number(t[2]), max: Number(t[3]), default: Number(t[4]) };
    case 'bool':
      // BRDFBase reads the default as an int (0/1).
      return { kind: 'bool', name: t[1], default: Number(t[2]) !== 0 };
    case 'color':
      return { kind: 'color', name: t[1], default: [Number(t[2]), Number(t[3]), Number(t[4])] };
    default:
      return null;
  }
}

export function parseBrdf(name: string, text: string): BrdfDef {
  const lines = text.split(/\r?\n/);
  const params: ParamDef[] = [];
  const shaderLines: string[] = [];
  const isFuncLines: string[] = [];

  let sawAnalytic = false;
  let section: 'none' | 'parameters' | 'shader' | 'isFunc' = 'none';

  for (const raw of lines) {
    const trimmed = raw.trim();

    if (section === 'none') {
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      if (!sawAnalytic) {
        if (trimmed !== 'analytic') {
          throw new Error(`${name}: expected 'analytic' as first directive, got '${trimmed}'`);
        }
        sawAnalytic = true;
        continue;
      }
      if (trimmed === '::begin parameters') section = 'parameters';
      else if (trimmed === '::begin shader') section = 'shader';
      else if (trimmed === '::begin isFunc') section = 'isFunc';
      continue;
    }

    if (section === 'parameters') {
      if (trimmed === '::end parameters') {
        section = 'none';
        continue;
      }
      const cleaned = stripComment(raw);
      if (cleaned.trim() === '') continue;
      const p = parseParam(cleaned);
      if (p) params.push(p);
      continue;
    }

    if (section === 'shader') {
      if (trimmed === '::end shader') {
        section = 'none';
        continue;
      }
      shaderLines.push(raw); // verbatim
      continue;
    }

    // section === 'isFunc'
    if (trimmed === '::end isFunc') {
      section = 'none';
      continue;
    }
    isFuncLines.push(raw); // verbatim
  }

  if (!sawAnalytic) throw new Error(`${name}: not an analytic .brdf file`);

  return {
    name,
    params,
    shaderSource: shaderLines.join('\n'),
    isFuncSource: isFuncLines.length ? isFuncLines.join('\n') : null,
  };
}
