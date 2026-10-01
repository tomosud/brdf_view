// window.brdfView: page-level automation API for scripts, Playwright and AI
// agents. Works on the static GitHub Pages build (no server needed).
// Usage reference: docs/ai_control.md.

import type { Store } from '../state/store.js';
import type { BrdfInstance, ParamValue } from '../brdf/types.js';
import { shaderErrors } from '../gl/brdf-program.js';
import { defaultColorSpace, loadTextureImage } from '../brdf/param-texture.js';
import type { TextureChannel, TextureColorSpace } from '../brdf/types.js';
import type { SnapshotOptions, ViewKey } from '../views/base-view.js';
import type { LitObjectView } from '../views/lit-object.js';
import { BrdfEvaluator, type EvalSample, type Vec3 } from './evaluate.js';
import { DATA_VIEWS, exportData, sph, type ExportOptions } from './export-data.js';
import {
  STATE_VERSION,
  VIEW_KEYS,
  applyState,
  collectState,
  linkState,
  setInstanceParam,
  stateFromParams,
  stateToHash,
  type ViewMap,
  type ViewerState,
} from './state.js';

/** A loaded BRDF: index into state.brdfs, bundled file name, or display name. Default: topmost visible. */
export type BrdfRef = number | string | undefined;

/** Evaluation input: vectors, or angles in degrees (theta from N, phi from X). */
export type EvalInput =
  | EvalSample
  | { thetaL: number; phiL?: number; thetaV: number; phiV?: number; N?: Vec3; X?: Vec3; Y?: Vec3 };

const VIEW_ALIASES: Record<string, ViewKey> = {
  plot3d: 'plot3d',
  '3d': 'plot3d',
  polar: 'polar',
  cartesian: 'cartesian',
  thetav: 'cartesian',
  slice: 'slice',
  imageslice: 'slice',
  image: 'slice',
  litobject: 'litObject',
  lit: 'litObject',
  object: 'litObject',
  ibl: 'litObject',
  litsphere: 'litSphere',
  sphere: 'litSphere',
};

export function resolveViewKey(name: string): ViewKey {
  const key = VIEW_ALIASES[name.replace(/[^A-Za-z0-9]/g, '').toLowerCase()];
  if (!key) throw new Error(`unknown view "${name}" (use ${VIEW_KEYS.join(', ')})`);
  return key;
}

export function installApi(store: Store, views: ViewMap, ready: Promise<void>): void {
  let evaluator: BrdfEvaluator | null = null;
  const getEvaluator = () => (evaluator ??= new BrdfEvaluator());
  let manifest: Promise<string[]> | null = null;

  const findBrdf = (ref: BrdfRef): BrdfInstance => {
    const list = store.state.brdfs;
    let inst: BrdfInstance | undefined;
    if (ref === undefined || ref === null) {
      inst = store.topmostEnabled()?.instance ?? list[0];
    } else if (typeof ref === 'number') {
      inst = list[ref];
    } else {
      inst = list.find((b) => b.def.origin?.kind === 'bundled' && b.def.origin.filename === ref) ?? list.find((b) => b.def.name === ref);
    }
    if (!inst) throw new Error(`BRDF ${ref === undefined ? '(visible)' : JSON.stringify(ref)} is not loaded`);
    return inst;
  };

  const viewOf = (name: string) => {
    const key = resolveViewKey(name);
    const view = views[key];
    if (!view) throw new Error(`view "${key}" is not available in this page`);
    return view;
  };

  const toSample = (x: EvalInput): EvalSample => {
    if ('L' in x && 'V' in x) return x;
    const a = x as { thetaL: number; phiL?: number; thetaV: number; phiV?: number; N?: Vec3; X?: Vec3; Y?: Vec3 };
    const d = Math.PI / 180;
    // Angles are relative to the local frame N/X/Y (defaults: z-up).
    const N = a.N ?? [0, 0, 1];
    const X = a.X ?? [1, 0, 0];
    const Y = a.Y ?? [0, 1, 0];
    const local = (t: number, p: number): Vec3 => {
      const v = sph(t * d, p * d);
      return [
        v[0] * X[0] + v[1] * Y[0] + v[2] * N[0],
        v[0] * X[1] + v[1] * Y[1] + v[2] * N[1],
        v[0] * X[2] + v[1] * Y[2] + v[2] * N[2],
      ];
    };
    return { L: local(a.thetaL, a.phiL ?? 0), V: local(a.thetaV, a.phiV ?? 0), N, X, Y };
  };

  const api = {
    version: STATE_VERSION,
    /** Resolves when the views exist, templates are loaded and the start-up state is applied. */
    ready,

    getState(): ViewerState {
      return collectState(store, views);
    },

    /** Apply a partial state (see docs/ai_control.md). Resolves after BRDF/env/mesh loads. */
    async setState(state: ViewerState | string): Promise<{ warnings: string[] }> {
      await ready;
      const parsed: ViewerState | null =
        typeof state === 'string' ? (state.trim().startsWith('{') ? JSON.parse(state) : await stateFromParams(extractParams(state))) : state;
      if (!parsed) throw new Error('setState: not a state (JSON object or link with v=1)');
      const warnings = await applyState(store, views, parsed);
      for (const w of warnings) console.warn(`[brdfView] ${w}`);
      return { warnings };
    },

    /** Shareable URL of the current state (current page origin and path). */
    async getLink(): Promise<string> {
      const hash = await stateToHash(linkState(store, views));
      return `${location.origin}${location.pathname}#${hash}`;
    },

    /** Bundled sample files and the currently loaded BRDFs. */
    async listBrdfs() {
      manifest ??= fetch(`${import.meta.env.BASE_URL}brdfs/index.json`).then((r) => (r.ok ? r.json() : []));
      const top = store.topmostEnabled()?.instance;
      return {
        available: (await manifest) as string[],
        loaded: store.state.brdfs.map((b, index) => ({
          index,
          name: b.def.name,
          file: b.def.origin?.kind === 'bundled' ? b.def.origin.filename : null,
          kind: b.def.measured ? 'measured' : 'analytic',
          visible: b.visible,
          active: b === top,
        })),
      };
    },

    /** Parameters of a loaded BRDF with their current values. */
    listParams(brdf?: BrdfRef) {
      const inst = findBrdf(brdf);
      return inst.def.params.map((p) => ({
        name: p.name,
        kind: p.kind,
        ...(p.kind === 'float' ? { min: p.min, max: p.max } : {}),
        default: p.default,
        value: inst.values.get(p.name) as ParamValue,
        description: p.description ?? '',
      }));
    },

    /** Set one parameter (float: number, bool: true/false, color: [r,g,b] or "r,g,b"). */
    setParam(name: string, value: unknown, brdf?: BrdfRef): ParamValue {
      const inst = findBrdf(brdf);
      const err = setInstanceParam(inst, name, value);
      if (err) throw new Error(err);
      store.emit();
      return inst.values.get(name) as ParamValue;
    },

    /**
     * Attach an image to a float/color parameter (Lit Object, mapped with the mesh UVs);
     * `src` is a URL or data URL, null removes it. Not stored in state / links.
     */
    async setTexture(
      name: string,
      src: string | null,
      opts: { brdf?: BrdfRef; fileName?: string; channel?: TextureChannel; colorSpace?: TextureColorSpace } = {},
    ): Promise<{ width: number; height: number } | null> {
      await ready;
      const inst = findBrdf(opts.brdf);
      const p = inst.def.params.find((x) => x.name === name);
      if (!p || p.kind === 'bool') throw new Error(`"${name}" is not a float/color parameter of ${inst.def.name}`);
      if (src === null) {
        store.setParamTexture(inst.id, name, null);
        return null;
      }
      const img = await fetchImage(src, opts.fileName ?? name);
      const channel: TextureChannel = p.kind === 'color' ? 'rgb' : opts.channel && opts.channel !== 'rgb' ? opts.channel : 'r';
      if (opts.channel && !['rgb', 'r', 'g', 'b', 'a'].includes(opts.channel)) throw new Error(`setTexture: unknown channel "${opts.channel}"`);
      const colorSpace = opts.colorSpace ?? defaultColorSpace(name);
      if (colorSpace !== 'srgb' && colorSpace !== 'linear') throw new Error(`setTexture: colorSpace must be "srgb" or "linear"`);
      store.setParamTexture(inst.id, name, { ...img, channel, colorSpace });
      return { width: img.width, height: img.height };
    },

    /**
     * Attach a tangent-space normal map to a BRDF for Lit Object. DirectX
     * convention (green flipped) by default; flipY: false for OpenGL maps. `src` is a URL or data URL, null removes it.
     */
    async setNormalMap(
      src: string | null,
      opts: { brdf?: BrdfRef; fileName?: string; flipY?: boolean; strength?: number } = {},
    ): Promise<{ width: number; height: number } | null> {
      await ready;
      const inst = findBrdf(opts.brdf);
      if (src === null) {
        store.setNormalMap(inst.id, null);
        return null;
      }
      const img = await fetchImage(src, opts.fileName ?? 'normal');
      store.setNormalMap(inst.id, { ...img, flipY: opts.flipY ?? true, strength: opts.strength ?? 1 });
      return { width: img.width, height: img.height };
    },

    /** View keys, plus the environments / objects selectable in litObject. */
    listViews() {
      const lit = views.litObject as LitObjectView | undefined;
      return {
        views: VIEW_KEYS.filter((k) => views[k]),
        dataViews: DATA_VIEWS.filter((k) => views[k]),
        ...(lit ? lit.available() : { environments: [], objects: [] }),
      };
    },

    /**
     * Render one view at a fixed size and return a PNG data URL.
     * litObject with IBL accumulates `frames` passes (default 512, the converged count).
     * supersample: draw at N x the size and box-filter down in linear light (anti-aliasing, default 1).
     * background: "view" (default), "transparent" or an sRGB [r, g, b] (litObject / litSphere only).
     * Output is the display image (exposure / gamma applied); use evaluate / exportData for numbers.
     */
    async render(view: string, opts: { width?: number; height?: number } & SnapshotOptions = {}): Promise<string> {
      await ready;
      return viewOf(view).snapshot(opts.width ?? 512, opts.height ?? 512, {
        frames: opts.frames,
        supersample: opts.supersample,
        background: opts.background,
      });
    },

    /**
     * Raw BRDF RGB for one input (returns [r,g,b]) or an array (returns [[r,g,b], ...]).
     * Options: brdf (which loaded BRDF), params (temporary overrides, state unchanged).
     */
    async evaluate(input: EvalInput | EvalInput[], opts: { brdf?: BrdfRef; params?: Record<string, unknown> } = {}) {
      await ready;
      let inst = findBrdf(opts.brdf);
      if (opts.params) {
        const tmp: BrdfInstance = { ...inst, values: new Map(inst.values) };
        for (const [k, v] of Object.entries(opts.params)) {
          const err = setInstanceParam(tmp, k, v);
          if (err) throw new Error(err);
        }
        inst = tmp;
      }
      const list = Array.isArray(input) ? input : [input];
      const rgb = await getEvaluator().evaluate(inst, list.map(toSample));
      const out: Vec3[] = list.map((_, i) => [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]]);
      return Array.isArray(input) ? out : out[0];
    },

    /** Numbers behind slice / polar / cartesian / plot3d (JSON object, or CSV text with format: 'csv'). */
    async exportData(view: string, opts: ExportOptions = {}) {
      await ready;
      return exportData(resolveViewKey(view), store, views, getEvaluator(), opts);
    },

    /** Shader compile/link errors seen so far. */
    errors(): string[] {
      return [...shaderErrors];
    },
  };

  (window as unknown as { brdfView: typeof api }).brdfView = api;
}

async function fetchImage(src: string, fallbackName: string) {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`image: ${res.status} for ${src.slice(0, 80)}`);
  const fileName = src.startsWith('data:') ? `${fallbackName}.png` : decodeURIComponent(src.split(/[?#]/)[0].split('/').pop() || fallbackName);
  return loadTextureImage(await res.blob(), fallbackName.includes('.') ? fallbackName : fileName);
}

/** Accept a full URL, "#v=1&..." or "v=1&..." and return the parameter part. */
function extractParams(text: string): string {
  const t = text.trim();
  const hash = t.indexOf('#');
  if (hash >= 0) return t.slice(hash + 1);
  const q = t.indexOf('?');
  return q >= 0 ? t.slice(q + 1) : t;
}
