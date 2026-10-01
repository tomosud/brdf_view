// Common scaffolding for a canvas-backed view: owns its own WebGL2 context,
// schedules redraws via requestAnimationFrame, and keeps the backing store
// sized to the CSS box (DPR-aware). Subclasses implement draw().
//
// For automation (window.brdfView), every view also has a stable key, exposes
// its local controls as a plain JSON object (getViewState / applyViewState),
// and can render one frame at a fixed backing-store size (snapshot).

import { resizeToDisplay } from '../gl/renderer.js';
import type { Store } from '../state/store.js';

/** Stable view identifiers used by the state JSON, the URL and the API. */
export type ViewKey = 'plot3d' | 'polar' | 'cartesian' | 'slice' | 'litObject' | 'litSphere';

export type ViewState = Record<string, unknown>;

export abstract class BaseView {
  readonly key: ViewKey;
  protected readonly root: HTMLElement;
  protected readonly titleEl: HTMLHeadingElement;
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  /** Optional strip below the canvas for view-specific controls. */
  protected readonly footer: HTMLElement;
  protected store: Store;
  /** Resolves once the view's shader templates are loaded. Subclasses replace it. */
  ready: Promise<unknown> = Promise.resolve();
  private rafPending = false;
  /** Fixed backing-store size while a snapshot is being taken. */
  private fixedSize: { width: number; height: number } | null = null;
  /** While true, scheduled animation-frame redraws are deferred. */
  private snapshotting = false;
  private unsub: () => void;

  constructor(key: ViewKey, container: HTMLElement, store: Store, title: string, description?: string) {
    this.key = key;
    this.store = store;

    const wrap = document.createElement('section');
    wrap.className = 'view';
    wrap.dataset.testid = `view-${key}`;
    wrap.dataset.view = key;
    this.root = wrap;
    const h = document.createElement('h2');
    this.titleEl = h;
    h.textContent = title;
    if (description) h.title = description;
    this.canvas = document.createElement('canvas');
    this.canvas.dataset.testid = `canvas-${key}`;
    this.canvas.setAttribute('aria-label', `${title} canvas`);
    if (description) this.canvas.title = description;
    this.footer = document.createElement('div');
    this.footer.className = 'view-controls';
    this.footer.dataset.testid = `controls-${key}`;
    wrap.append(h, this.canvas, this.footer);
    container.append(wrap);

    const gl = this.canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 context creation failed');
    this.gl = gl;

    new ResizeObserver(() => this.requestRender()).observe(this.canvas);
    this.unsub = store.subscribe(() => this.requestRender());
  }

  protected setViewTitle(title: string, description?: string): void {
    this.titleEl.textContent = title;
    this.titleEl.title = description ?? '';
    this.canvas.title = description ?? '';
  }

  /** Schedule a redraw on the next animation frame (coalesced). */
  requestRender(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      if (this.snapshotting) return; // snapshot() requests a redraw when it is done
      this.renderFrame();
    });
  }

  /** Size the backing store (fixed or display-sized) and draw one frame now. */
  protected renderFrame(): void {
    if (this.fixedSize) {
      const { width, height } = this.fixedSize;
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      this.gl.viewport(0, 0, width, height);
    } else if (resizeToDisplay(this.canvas)) {
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
    this.draw();
  }

  /**
   * Render this view at exactly width x height pixels and return a PNG data URL.
   * The result depends only on the app state and the size (no animation, no DPR).
   */
  async snapshot(width: number, height: number, options: SnapshotOptions = {}): Promise<string> {
    await this.ready;
    await this.prepareSnapshot();
    const outW = Math.max(1, Math.round(width));
    const outH = Math.max(1, Math.round(height));
    const bg = options.background ?? 'view';
    if (bg !== 'view' && !this.supportsBackgroundOverride) {
      throw new Error(`render: background "${JSON.stringify(bg)}" is only supported by litObject and litSphere`);
    }
    // Supersampling: draw at ss x the size, then box-filter down (in linear light).
    const maxDim = Math.min(...(this.gl.getParameter(this.gl.MAX_VIEWPORT_DIMS) as Int32Array), 16384);
    let ss = Math.max(1, Math.min(8, Math.round(options.supersample ?? 1)));
    while (ss > 1 && (outW * ss > maxDim || outH * ss > maxDim)) ss--;
    this.snapshotting = true;
    this.fixedSize = { width: outW * ss, height: outH * ss };
    this.snapshotClearAlpha = bg !== 'view';
    try {
      this.renderSnapshot(options);
      // Read back in the same task as the draw, so preserveDrawingBuffer is not needed.
      if (ss === 1 && bg === 'view') return this.canvas.toDataURL('image/png');
      return downsampleToPng(this.canvas, ss, outW, outH, bg);
    } finally {
      this.fixedSize = null;
      this.snapshotting = false;
      this.snapshotClearAlpha = false;
      this.requestRender();
    }
  }

  /** Views that can draw their background as alpha 0 (see snapshotClearAlpha). */
  protected readonly supportsBackgroundOverride: boolean = false;
  /**
   * True while a snapshot with background "transparent" or a color is drawn:
   * views that support it clear the background to (0,0,0,0) and skip drawing it,
   * so the geometry coverage ends up in alpha.
   */
  protected snapshotClearAlpha = false;

  /** Hook for async work that must finish before a snapshot (e.g. pending loads). */
  protected async prepareSnapshot(): Promise<void> {}

  /** Draw the snapshot frame(s). Views that accumulate override this. */
  protected renderSnapshot(_options: { frames?: number }): void {
    this.renderFrame();
  }

  /** Local view controls as plain JSON (angles in degrees). */
  getViewState(): ViewState {
    return {};
  }

  /** Apply a (partial) local view state. Unknown keys are ignored. */
  async applyViewState(_state: ViewState): Promise<void> {}

  dispose(): void {
    this.unsub();
  }

  protected abstract draw(): void;
}

/**
 * Snapshot options.
 * - frames: IBL accumulation passes (litObject)
 * - supersample: render at N x the size and box-filter down (1-8, default 1)
 * - background: "view" (the view's own background, default), "transparent",
 *   or an sRGB color [r, g, b] in 0-1 (litObject / litSphere only)
 */
export interface SnapshotOptions {
  frames?: number;
  supersample?: number;
  background?: 'view' | 'transparent' | [number, number, number];
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/**
 * Box-filter the (ss x larger) WebGL canvas down to outW x outH in linear light,
 * with premultiplied alpha, then composite over `bg` (or keep alpha) and encode PNG.
 * Must run in the same task as the draw (the drawing buffer is not preserved).
 */
function downsampleToPng(
  src: HTMLCanvasElement,
  ss: number,
  outW: number,
  outH: number,
  bg: 'view' | 'transparent' | [number, number, number],
): string {
  const big = document.createElement('canvas');
  big.width = src.width;
  big.height = src.height;
  const bctx = big.getContext('2d')!;
  bctx.drawImage(src, 0, 0);
  const inp = bctx.getImageData(0, 0, big.width, big.height).data;
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = srgbToLinear(i / 255);
  const bgLin = Array.isArray(bg) ? bg.map((c) => srgbToLinear(Math.min(1, Math.max(0, c)))) : null;

  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const octx = out.getContext('2d')!;
  const img = octx.createImageData(outW, outH);
  const o = img.data;
  const inv = 1 / (ss * ss);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        let p = ((y * ss + sy) * big.width + x * ss) * 4;
        for (let sx = 0; sx < ss; sx++, p += 4) {
          const al = bg === 'view' ? 1 : inp[p + 3] / 255;
          r += lut[inp[p]] * al;
          g += lut[inp[p + 1]] * al;
          b += lut[inp[p + 2]] * al;
          a += al;
        }
      }
      r *= inv; g *= inv; b *= inv; a *= inv;
      const q = (y * outW + x) * 4;
      if (bgLin) {
        r += bgLin[0] * (1 - a);
        g += bgLin[1] * (1 - a);
        b += bgLin[2] * (1 - a);
        a = 1;
      } else if (a > 0) {
        r /= a; g /= a; b /= a;
      }
      o[q] = Math.round(linearToSrgb(Math.min(1, r)) * 255);
      o[q + 1] = Math.round(linearToSrgb(Math.min(1, g)) * 255);
      o[q + 2] = Math.round(linearToSrgb(Math.min(1, b)) * 255);
      o[q + 3] = Math.round(a * 255);
    }
  }
  octx.putImageData(img, 0, 0);
  return out.toDataURL('image/png');
}

/** Read helpers for applyViewState: return undefined when the key is absent or invalid. */
export function num(state: ViewState, key: string): number | undefined {
  const v = state[key];
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function bool(state: ViewState, key: string): boolean | undefined {
  const v = state[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).toLowerCase();
  if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false;
  return undefined;
}

export function str(state: ViewState, key: string): string | undefined {
  const v = state[key];
  return v === undefined || v === null ? undefined : String(v);
}

export function obj(state: ViewState, key: string): ViewState {
  const v = state[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as ViewState) : {};
}

export const RAD2DEG = 180 / Math.PI;
export const DEG2RAD_ = Math.PI / 180;

/** Round for JSON output so radians -> degrees round-trips stay readable. */
export function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
