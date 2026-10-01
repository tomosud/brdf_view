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
  async snapshot(width: number, height: number, options: { frames?: number } = {}): Promise<string> {
    await this.ready;
    await this.prepareSnapshot();
    this.snapshotting = true;
    this.fixedSize = { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
    try {
      this.renderSnapshot(options);
      // Read back in the same task as the draw, so preserveDrawingBuffer is not needed.
      return this.canvas.toDataURL('image/png');
    } finally {
      this.fixedSize = null;
      this.snapshotting = false;
      this.requestRender();
    }
  }

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
