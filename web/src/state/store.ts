// Single source of truth, mirroring ParameterWindow's role: it owns the BRDF
// list and global plot state and notifies subscribers (each view) on change.
// The package selector reproduces ParameterWindow::emitBRDFListChanged /
// getBRDFList (solo, solo-colors, channel -> colorMask).

import type { BrdfInstance, ParamValue } from '../brdf/types.js';

export type Channel = 'red' | 'green' | 'blue' | 'luminance';

const COLOR_MASK: Record<Channel, [number, number, number]> = {
  red: [1, 0, 0],
  green: [0, 1, 0],
  blue: [0, 0, 1],
  luminance: [0.3, 0.59, 0.11], // matches ParameterWindow::setBRDFColorMask
};

// Default per-BRDF display colors, cycled as BRDFs are added. Saturated so they
// read on both the dark 3D/sphere views and the white polar/cartesian views.
const PALETTE: [number, number, number][] = [
  [0.85, 0.12, 0.12],
  [0.12, 0.4, 0.9],
  [0.1, 0.65, 0.2],
  [0.9, 0.5, 0.1],
  [0.6, 0.2, 0.8],
  [0.1, 0.65, 0.65],
];

/** One drawable pass: a BRDF instance with its display color and channel mask. */
export interface BrdfPackage {
  instance: BrdfInstance;
  drawColor: [number, number, number];
  colorMask: [number, number, number];
}

export interface AppState {
  brdfs: BrdfInstance[];
  drawColors: Map<string, [number, number, number]>;
  channel: Channel;
  useLogPlot: boolean;
  useNDotL: boolean;
  incidentTheta: number;
  incidentPhi: number;
  soloId: string | null;
  soloColors: boolean;
}

type Listener = () => void;

export class Store {
  state: AppState = {
    brdfs: [],
    drawColors: new Map(),
    channel: 'luminance',
    useLogPlot: false,
    useNDotL: false,
    incidentTheta: 0.785398163,
    incidentPhi: 0.785398163,
    soloId: null,
    soloColors: false,
  };

  private listeners = new Set<Listener>();
  private paletteIndex = 0;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Notify all views. Call after any mutation. */
  emit(): void {
    for (const fn of this.listeners) fn();
  }

  addBrdf(instance: BrdfInstance, makeVisible = true): void {
    if (makeVisible) {
      for (const b of this.state.brdfs) b.visible = false;
      instance.visible = true;
    }
    this.state.drawColors.set(instance.id, PALETTE[this.paletteIndex++ % PALETTE.length]);
    this.state.brdfs.push(instance);
    this.emit();
  }

  removeBrdf(id: string): void {
    const wasVisible = this.state.brdfs.some((b) => b.id === id && b.visible);
    this.state.brdfs = this.state.brdfs.filter((b) => b.id !== id);
    this.state.drawColors.delete(id);
    if (this.state.soloId === id) this.state.soloId = null;
    if (wasVisible && !this.state.brdfs.some((b) => b.visible) && this.state.brdfs.length) {
      this.state.brdfs[0].visible = true;
    }
    this.emit();
  }

  setVisible(id: string, visible: boolean): void {
    for (const b of this.state.brdfs) {
      b.visible = visible && b.id === id;
    }
    this.emit();
  }

  setParam(id: string, name: string, value: ParamValue): void {
    const b = this.state.brdfs.find((x) => x.id === id);
    if (b) {
      b.values.set(name, value);
      this.emit();
    }
  }

  resetParams(id: string): void {
    const b = this.state.brdfs.find((x) => x.id === id);
    if (!b) return;
    for (const p of b.def.params) {
      b.values.set(p.name, Array.isArray(p.default) ? ([...p.default] as [number, number, number]) : p.default);
    }
    this.emit();
  }

  patch(p: Partial<AppState>): void {
    Object.assign(this.state, p);
    this.emit();
  }

  /** Derived drawable list, honoring solo / solo-colors / channel selection. */
  packages(): BrdfPackage[] {
    const s = this.state;
    const mask = COLOR_MASK[s.channel];

    if (s.soloId) {
      const inst = s.brdfs.find((b) => b.id === s.soloId);
      if (!inst) return [];
      if (s.soloColors) {
        return [
          { instance: inst, colorMask: [1, 0, 0], drawColor: [0.65, 0, 0] },
          { instance: inst, colorMask: [0, 1, 0], drawColor: [0, 0.65, 0] },
          { instance: inst, colorMask: [0, 0, 1], drawColor: [0, 0, 0.65] },
        ];
      }
      return [{ instance: inst, colorMask: mask, drawColor: this.drawColor(inst.id) }];
    }

    return s.brdfs
      .filter((b) => b.visible)
      .map((b) => ({ instance: b, colorMask: mask, drawColor: this.drawColor(b.id) }));
  }

  /** The single topmost enabled BRDF (Lit Sphere / Image Slice / IBL use this). */
  topmostEnabled(): BrdfPackage | null {
    const pkgs = this.packages();
    return pkgs.length ? pkgs[0] : null;
  }

  drawColor(id: string): [number, number, number] {
    return this.state.drawColors.get(id) ?? [0.9, 0.9, 0.9];
  }
}
