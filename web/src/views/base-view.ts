// Common scaffolding for a canvas-backed view: owns its own WebGL2 context,
// schedules redraws via requestAnimationFrame, and keeps the backing store
// sized to the CSS box (DPR-aware). Subclasses implement draw().

import { resizeToDisplay } from '../gl/renderer.js';
import type { Store } from '../state/store.js';

export abstract class BaseView {
  protected readonly root: HTMLElement;
  protected readonly titleEl: HTMLHeadingElement;
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  /** Optional strip below the canvas for view-specific controls. */
  protected readonly footer: HTMLElement;
  protected store: Store;
  private rafPending = false;
  private unsub: () => void;

  constructor(container: HTMLElement, store: Store, title: string, description?: string) {
    this.store = store;

    const wrap = document.createElement('section');
    wrap.className = 'view';
    this.root = wrap;
    const h = document.createElement('h2');
    this.titleEl = h;
    h.textContent = title;
    if (description) h.title = description;
    this.canvas = document.createElement('canvas');
    if (description) this.canvas.title = description;
    this.footer = document.createElement('div');
    this.footer.className = 'view-controls';
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
      if (resizeToDisplay(this.canvas)) {
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      }
      this.draw();
    });
  }

  dispose(): void {
    this.unsub();
  }

  protected abstract draw(): void;
}
