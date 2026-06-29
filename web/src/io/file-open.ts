// Runtime file loading, dispatched by extension (matching createBRDFFromFile):
//   .brdf   -> analytic BRDF
//   .binary -> MERL measured BRDF
// (.dat anisotropic measured and .bparam are future work.)

import { parseBrdf } from '../brdf/parser.js';
import { instanceFromDef } from '../brdf/loader.js';
import { measuredBrdfFromBuffer } from '../brdf/measured.js';
import type { BrdfDef, BrdfInstance } from '../brdf/types.js';

export async function loadBrdfFile(file: File): Promise<BrdfInstance> {
  const name = file.name.replace(/\.[^.]+$/, '');
  const ext = file.name.toLowerCase().split('.').pop();
  if (ext === 'brdf') {
    const text = await file.text();
    const def = parseBrdf(name, text);
    def.origin = { kind: 'text', name, content: text };
    return instanceFromDef(def);
  }
  if (ext === 'binary') {
    return measuredBrdfFromBuffer(name, await file.arrayBuffer());
  }
  throw new Error(`unsupported file type: .${ext}`);
}

/** Fetch a MERL .binary by URL. The binary is not cached in IndexedDB. */
export async function loadMeasuredFromUrl(url: string, name: string, origin?: BrdfDef['origin']): Promise<BrdfInstance> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
  return measuredBrdfFromBuffer(name, await res.arrayBuffer(), origin);
}
