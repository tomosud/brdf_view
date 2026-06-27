// Fetches and parses a bundled .brdf, returning a ready-to-use BrdfInstance.

import { parseBrdf } from './parser.js';
import type { BrdfInstance, ParamValue } from './types.js';

let counter = 0;

export function instanceFromDef(def: ReturnType<typeof parseBrdf>): BrdfInstance {
  const values = new Map<string, ParamValue>();
  for (const p of def.params) {
    if (p.kind === 'float') values.set(p.name, p.default);
    else if (p.kind === 'bool') values.set(p.name, p.default);
    else values.set(p.name, [...p.default]);
  }
  return { id: `brdf-${counter++}`, def, values, visible: true };
}

export async function loadBundledBrdf(fileName: string): Promise<BrdfInstance> {
  const url = `${import.meta.env.BASE_URL}brdfs/${fileName}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${fileName}: ${res.status}`);
  const text = await res.text();
  const name = fileName.replace(/\.brdf$/i, '');
  const def = parseBrdf(name, text);
  def.origin = { kind: 'bundled', filename: fileName };
  return instanceFromDef(def);
}
