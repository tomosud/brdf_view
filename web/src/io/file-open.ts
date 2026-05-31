// Runtime file loading, dispatched by extension (matching createBRDFFromFile):
//   .brdf   -> analytic BRDF
//   .binary -> MERL measured BRDF
// (.dat anisotropic measured and .bparam are future work.)

import { parseBrdf } from '../brdf/parser.js';
import { instanceFromDef } from '../brdf/loader.js';
import { measuredBrdfFromBuffer } from '../brdf/measured.js';
import type { BrdfInstance } from '../brdf/types.js';

export async function loadBrdfFile(file: File): Promise<BrdfInstance> {
  const name = file.name.replace(/\.[^.]+$/, '');
  const ext = file.name.toLowerCase().split('.').pop();
  if (ext === 'brdf') {
    return instanceFromDef(parseBrdf(name, await file.text()));
  }
  if (ext === 'binary') {
    return measuredBrdfFromBuffer(name, await file.arrayBuffer());
  }
  throw new Error(`unsupported file type: .${ext}`);
}

/** Fetch a bundled MERL .binary by URL (used by the "load sample" affordance). */
export async function loadMeasuredFromUrl(url: string, name: string): Promise<BrdfInstance> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
  return measuredBrdfFromBuffer(name, await res.arrayBuffer());
}
