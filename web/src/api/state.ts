// Viewer state as one JSON object (format version 1), shared by
// window.brdfView.getState/setState, the "State JSON" panel and shared links.
//
// JSON shape (all angles in degrees; every key optional in setState):
//   {
//     "v": 1,
//     "brdfs": [ { "file": "callisto_brdf.brdf", "visible": true, "params": { "roughness": 0.4 } },
//                { "name": "my.brdf", "source": "<.brdf text>", "visible": false } ],
//     "light": { "theta": 45, "phi": 45 },
//     "plot": { "channel": "luminance", "logPlot": true, "nDotL": false },
//     "display": { "toneMap": false, "hdr": false },
//     "plot3d": {...}, "polar": {...}, "cartesian": {...}, "slice": {...},
//     "litObject": {...}, "litSphere": {...}
//   }
//
// Links put the same object in the URL hash, flattened to dotted keys:
//   #v=1&brdfs.0.file=callisto_brdf.brdf&brdfs.0.params.base_color=0.8,0.5,0.4&light.theta=60
// Unknown keys are ignored. A `source` (non-bundled .brdf text) is stored
// deflate-compressed as `deflate:<base64url>`.

import type { Channel, Store } from '../state/store.js';
import type { BrdfInstance, ParamDef, ParamValue } from '../brdf/types.js';
import { instanceFromDef, loadBundledBrdf } from '../brdf/loader.js';
import { parseBrdf } from '../brdf/parser.js';
import { bool, num, round6, str, type BaseView, type ViewKey, type ViewState } from '../views/base-view.js';

export const STATE_VERSION = 1;

export const VIEW_KEYS: readonly ViewKey[] = ['plot3d', 'polar', 'cartesian', 'slice', 'litObject', 'litSphere'];

export interface BrdfEntryState {
  /** Bundled sample file name (sample/brdf/*.brdf), e.g. "callisto_brdf.brdf". */
  file?: string;
  /** Display name for non-bundled BRDFs. */
  name?: string;
  /** Full .brdf text for non-bundled (uploaded) BRDFs. */
  source?: string;
  /** Set for measured (MERL / RGL) BRDFs, which cannot be stored in a state. */
  measured?: boolean;
  /** Images attached to parameters (informational: images are not restored). */
  textures?: Record<string, { file: string; channel: string; colorSpace: string; modelDefault?: boolean }>;
  /** Normal map (informational: the image is not restored). modelDefault: a default texture of the Lit Object mesh. */
  normalMap?: { file: string; flipY: boolean; strength: number; modelDefault?: boolean };
  visible?: boolean;
  params?: Record<string, ParamValue>;
}

export interface ViewerState {
  v?: number;
  brdfs?: BrdfEntryState[];
  light?: { theta?: number; phi?: number };
  plot?: { channel?: Channel; logPlot?: boolean; nDotL?: boolean };
  /** Display transform of Lit Object / Lit Sphere / Image Slice (toneMap: ACES 2.0 SDR). */
  display?: { toneMap?: boolean; hdr?: boolean };
  plot3d?: ViewState;
  polar?: ViewState;
  cartesian?: ViewState;
  slice?: ViewState;
  litObject?: ViewState;
  litSphere?: ViewState;
}

const CHANNELS: readonly Channel[] = ['red', 'green', 'blue', 'luminance'];

export type ViewMap = Partial<Record<ViewKey, BaseView>>;

/** Snapshot the whole viewer state (all parameter values included). */
export function collectState(store: Store, views: ViewMap): ViewerState {
  const s = store.state;
  const state: ViewerState = {
    v: STATE_VERSION,
    brdfs: s.brdfs.map(entryFromInstance),
    light: { theta: round6((s.incidentTheta * 180) / Math.PI), phi: round6((s.incidentPhi * 180) / Math.PI) },
    plot: { channel: s.channel, logPlot: s.useLogPlot, nDotL: s.useNDotL },
    display: { toneMap: s.toneMap, hdr: s.hdr },
  };
  for (const key of VIEW_KEYS) {
    const view = views[key];
    if (view) state[key] = view.getViewState();
  }
  return state;
}

/** State for links: like collectState, but only the visible BRDFs. */
export function linkState(store: Store, views: ViewMap): ViewerState {
  const state = collectState(store, views);
  state.brdfs = (state.brdfs ?? []).filter((b) => b.visible);
  return state;
}

function entryFromInstance(inst: BrdfInstance): BrdfEntryState {
  const params: Record<string, ParamValue> = {};
  for (const p of inst.def.params) {
    const v = inst.values.get(p.name);
    if (v === undefined) continue;
    params[p.name] = Array.isArray(v) ? ([...v] as [number, number, number]) : v;
  }
  const origin = inst.def.origin;
  const entry: BrdfEntryState =
    origin?.kind === 'bundled'
      ? { file: origin.filename }
      : origin?.kind === 'text'
        ? { name: origin.name || inst.def.name, source: origin.content }
        : { name: inst.def.name, measured: true };
  entry.visible = inst.visible;
  entry.params = params;
  if (inst.textures?.size) {
    entry.textures = Object.fromEntries(
      [...inst.textures].map(([k, t]) => [
        k,
        { file: t.fileName, channel: t.channel, colorSpace: t.colorSpace, ...(t.modelDefault ? { modelDefault: true } : {}) },
      ]),
    );
  }
  if (inst.normalMap) {
    const n = inst.normalMap;
    entry.normalMap = { file: n.fileName, flipY: n.flipY, strength: n.strength, ...(n.modelDefault ? { modelDefault: true } : {}) };
  }
  return entry;
}

function sameOrigin(inst: BrdfInstance, e: BrdfEntryState): boolean {
  const o = inst.def.origin;
  if (e.file) return o?.kind === 'bundled' && o.filename === e.file;
  if (e.source !== undefined) return o?.kind === 'text' && o.content === e.source;
  return !o && !!e.name && inst.def.name === e.name;
}

/**
 * Apply a (partial) state. Sections that are absent are left unchanged; a
 * present `brdfs` list replaces the loaded list, and each entry's parameters
 * start from the .brdf defaults. Returns human-readable warnings.
 */
export async function applyState(store: Store, views: ViewMap, state: ViewerState): Promise<string[]> {
  const warnings: string[] = [];
  if (state.v !== undefined && Number(state.v) !== STATE_VERSION) {
    warnings.push(`state version ${state.v} is not ${STATE_VERSION}; applying known keys only`);
  }

  let brdfs: BrdfInstance[] | null = null;
  if (Array.isArray(state.brdfs)) {
    brdfs = [];
    const unused = [...store.state.brdfs];
    for (const [i, e] of state.brdfs.entries()) {
      if (!e || typeof e !== 'object') continue;
      const inst = await instanceForEntry(e, unused, warnings, i);
      if (!inst) continue;
      resetValues(inst);
      if (e.params && typeof e.params === 'object') {
        for (const [name, value] of Object.entries(e.params)) {
          const err = setInstanceParam(inst, name, value);
          if (err) warnings.push(`brdfs.${i}: ${err}`);
        }
      }
      inst.visible = e.visible === undefined ? false : bool({ v: e.visible }, 'v') ?? false;
      brdfs.push(inst);
    }
    if (brdfs.length && !brdfs.some((b) => b.visible)) brdfs[0].visible = true;
  }

  const s = store.state;
  if (state.light && typeof state.light === 'object') {
    const theta = num(state.light, 'theta');
    const phi = num(state.light, 'phi');
    if (theta !== undefined) s.incidentTheta = (theta * Math.PI) / 180;
    if (phi !== undefined) s.incidentPhi = (phi * Math.PI) / 180;
  }
  if (state.plot && typeof state.plot === 'object') {
    const channel = str(state.plot, 'channel');
    if (channel !== undefined) {
      if ((CHANNELS as readonly string[]).includes(channel)) s.channel = channel as Channel;
      else warnings.push(`plot.channel: unknown channel "${channel}" (${CHANNELS.join(', ')})`);
    }
    s.useLogPlot = bool(state.plot, 'logPlot') ?? s.useLogPlot;
    s.useNDotL = bool(state.plot, 'nDotL') ?? s.useNDotL;
  }
  if (state.display && typeof state.display === 'object') {
    s.toneMap = bool(state.display, 'toneMap') ?? s.toneMap;
    s.hdr = bool(state.display, 'hdr') ?? s.hdr;
  }

  if (brdfs) store.setBrdfs(brdfs);
  else store.emit();

  for (const key of VIEW_KEYS) {
    const vs = state[key];
    if (!vs || typeof vs !== 'object') continue;
    const view = views[key];
    if (!view) {
      warnings.push(`${key}: view not available`);
      continue;
    }
    await view.applyViewState(vs);
  }
  return warnings;
}

async function instanceForEntry(
  e: BrdfEntryState,
  unused: BrdfInstance[],
  warnings: string[],
  i: number,
): Promise<BrdfInstance | null> {
  const reuse = unused.findIndex((b) => sameOrigin(b, e));
  if (reuse >= 0) return unused.splice(reuse, 1)[0];
  try {
    if (e.file) return await loadBundledBrdf(e.file);
    if (typeof e.source === 'string') {
      const name = e.name || 'custom.brdf';
      const def = parseBrdf(name, e.source);
      def.origin = { kind: 'text', name, content: e.source };
      return instanceFromDef(def);
    }
    warnings.push(`brdfs.${i}: ${e.measured ? `measured BRDF "${e.name}" is not loaded and cannot be restored from a state` : 'needs "file" or "source"'}`);
  } catch (err) {
    warnings.push(`brdfs.${i}: ${(err as Error).message}`);
  }
  return null;
}

function resetValues(inst: BrdfInstance): void {
  for (const p of inst.def.params) {
    inst.values.set(p.name, Array.isArray(p.default) ? ([...p.default] as [number, number, number]) : p.default);
  }
}

/** Set one parameter with type coercion. Returns an error message, or null on success. */
export function setInstanceParam(inst: BrdfInstance, name: string, value: unknown): string | null {
  const p = inst.def.params.find((x) => x.name === name);
  if (!p) return `unknown parameter "${name}" for ${inst.def.name}`;
  const v = coerceParam(p, value);
  if (v === null) return `invalid value ${JSON.stringify(value)} for ${p.kind} parameter "${name}"`;
  inst.values.set(name, v);
  return null;
}

export function coerceParam(p: ParamDef, value: unknown): ParamValue | null {
  if (p.kind === 'float') {
    const n = typeof value === 'number' ? value : Number(value);
    return value === '' || value === null || !Number.isFinite(n) ? null : n;
  }
  if (p.kind === 'bool') {
    return bool({ v: value }, 'v') ?? null;
  }
  let arr: unknown[];
  if (Array.isArray(value)) arr = value;
  else if (typeof value === 'number') arr = [value, value, value];
  else if (typeof value === 'string') arr = value.split(',').map((x) => x.trim());
  else return null;
  if (arr.length === 1) arr = [arr[0], arr[0], arr[0]];
  if (arr.length !== 3) return null;
  const rgb = arr.map((x) => (typeof x === 'number' ? x : Number(x)));
  return rgb.every((x) => Number.isFinite(x)) ? (rgb as [number, number, number]) : null;
}

// ---------------------------------------------------------------------------
// URL encoding

/** Encode a state as URL hash parameters (without the leading '#'). */
export async function stateToHash(state: ViewerState): Promise<string> {
  const pairs: [string, string][] = [['v', String(state.v ?? STATE_VERSION)]];
  const walk = async (value: unknown, path: string): Promise<void> => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      if (value.length > 0 && value.every((x) => typeof x === 'number')) {
        pairs.push([path, value.map(String).join(',')]);
        return;
      }
      for (let i = 0; i < value.length; i++) await walk(value[i], `${path}.${i}`);
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (!path && k === 'v') continue;
        await walk(v, path ? `${path}.${k}` : k);
      }
      return;
    }
    if (path.endsWith('.source') && typeof value === 'string') {
      pairs.push([path, await packText(value)]);
      return;
    }
    pairs.push([path, String(value)]);
  };
  await walk(state, '');
  return pairs.map(([k, v]) => `${k}=${encodeValue(v)}`).join('&');
}

function encodeValue(v: string): string {
  return encodeURIComponent(v).replace(/%2C/g, ',').replace(/%3A/g, ':').replace(/%2F/g, '/');
}

/**
 * Parse state parameters from a URL hash or query ("#v=1&..." / "?v=1&...").
 * Returns null when there is no `v` key (not a state link).
 */
export async function stateFromParams(text: string): Promise<ViewerState | null> {
  const body = text.replace(/^[#?]/, '');
  if (!body) return null;
  const root: Record<string, unknown> = {};
  let hasVersion = false;
  for (const part of body.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = safeDecode(eq < 0 ? part : part.slice(0, eq));
    const raw = eq < 0 ? '' : safeDecode(part.slice(eq + 1));
    if (!/^[A-Za-z0-9_.]+$/.test(key)) continue; // unknown / foreign keys are ignored
    if (key === 'v') hasVersion = true;
    const value = key.endsWith('.source') ? await unpackText(raw) : parseScalar(raw);
    setPath(root, key.split('.'), value);
  }
  return hasVersion ? (root as ViewerState) : null;
}

/** Read a state from the page location: hash first, then query string. */
export async function stateFromLocation(loc: Location): Promise<ViewerState | null> {
  return (await stateFromParams(loc.hash)) ?? (await stateFromParams(loc.search));
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function parseScalar(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && !raw.includes(',') && Number.isFinite(Number(raw))) return Number(raw);
  if (raw.includes(',')) {
    const parts = raw.split(',');
    if (parts.every((p) => p.trim() !== '' && Number.isFinite(Number(p)))) return parts.map(Number);
  }
  return raw;
}

function setPath(root: Record<string, unknown>, keys: string[], value: unknown): void {
  let node: Record<string, unknown> | unknown[] = root;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const last = i === keys.length - 1;
    const slot = /^\d+$/.test(k) && Array.isArray(node) ? Number(k) : k;
    const container = node as Record<string | number, unknown>;
    if (last) {
      container[slot] = value;
      return;
    }
    let next = container[slot];
    if (!next || typeof next !== 'object') {
      next = /^\d+$/.test(keys[i + 1]) ? [] : {};
      container[slot] = next;
    }
    node = next as Record<string, unknown> | unknown[];
  }
}

async function packText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  if (typeof CompressionStream === 'undefined') return `b64:${toBase64Url(bytes)}`;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return `deflate:${toBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()))}`;
}

async function unpackText(raw: string): Promise<string> {
  if (raw.startsWith('b64:')) return new TextDecoder().decode(fromBase64Url(raw.slice(4)));
  if (raw.startsWith('deflate:')) {
    const bytes = fromBase64Url(raw.slice(8));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new TextDecoder().decode(await new Response(stream).arrayBuffer());
  }
  return raw;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
