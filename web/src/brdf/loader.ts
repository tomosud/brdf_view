// Fetches and parses a bundled .brdf, returning a ready-to-use BrdfInstance.

import { parseBrdf } from './parser.js';
import type { BrdfInstance, ParamValue } from './types.js';

let counter = 0;

export const CUSTOM_IMPLEMENTATION_BADGE = '[custom implementation / 独自実装]';

const CUSTOM_IMPLEMENTATION_LABELS: Readonly<Record<string, string>> = {
  'disney.brdf': `disney ${CUSTOM_IMPLEMENTATION_BADGE}`,
  'openpbr.brdf': `openpbr ${CUSTOM_IMPLEMENTATION_BADGE}`,
  'unreal_legacy_pbr.brdf': `unreal_legacy_pbr ${CUSTOM_IMPLEMENTATION_BADGE}`,
  'substrate.brdf': `substrate ${CUSTOM_IMPLEMENTATION_BADGE}`,
  'brdf_slice_guide.brdf': `brdf_slice_guide ${CUSTOM_IMPLEMENTATION_BADGE}`,
  'callisto_brdf.brdf': `callisto_brdf ${CUSTOM_IMPLEMENTATION_BADGE}`,
  'callisto_eye.brdf': `callisto_eye ${CUSTOM_IMPLEMENTATION_BADGE}`,
  'callisto_teeth.brdf': `callisto_teeth ${CUSTOM_IMPLEMENTATION_BADGE}`,
  'callisto_cloth_prisoner.brdf': `callisto_cloth_prisoner ${CUSTOM_IMPLEMENTATION_BADGE}`,
  'skintone_callisto_brdf.brdf': `skintone_callisto_brdf ${CUSTOM_IMPLEMENTATION_BADGE}`,
};

/** User-facing name for bundled samples that distinguishes project-specific implementations. */
export function bundledBrdfDisplayName(fileName: string): string {
  return CUSTOM_IMPLEMENTATION_LABELS[fileName.toLowerCase()] ?? fileName.replace(/\.brdf$/i, '');
}

/** Splits a custom implementation display name so the UI can render its badge on a second line. */
export function splitCustomImplementationName(displayName: string): { name: string; badge: string } | null {
  const suffix = ` ${CUSTOM_IMPLEMENTATION_BADGE}`;
  if (!displayName.endsWith(suffix)) return null;
  return { name: displayName.slice(0, -suffix.length), badge: CUSTOM_IMPLEMENTATION_BADGE };
}

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
  const name = bundledBrdfDisplayName(fileName);
  const def = parseBrdf(name, text);
  def.origin = { kind: 'bundled', filename: fileName };
  return instanceFromDef(def);
}
