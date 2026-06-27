// Cartesian angle plot. Port of Disney PlotCartesianWidget's Theta V / Theta H /
// Theta D / Albedo modes: x is the selected angle in [-pi/2, pi/2], y is BRDF value.
// Left-drag pans, right-drag zooms, Ctrl+drag changes x/y scale, double-click
// resets.

import { BaseView } from './base-view.js';
import { BrdfProgramCache } from '../gl/brdf-program.js';
import { Line2D } from '../gl/line2d.js';
import { createEmptyVAO } from '../gl/line-expansion.js';
import { ortho, scale, mul, type Mat4 } from '../gl/mat4.js';
import { boolControl, floatControl, labeledRow, selectControl } from '../ui/controls.js';
import type { Store } from '../state/store.js';

const SEGMENTS = 512;
const ALBEDO_SEGMENTS = 32;

type CartesianMode = 'thetaV' | 'thetaH' | 'thetaD' | 'albedo';

const MODE_OPTIONS: { value: CartesianMode; text: string }[] = [
  { value: 'thetaV', text: 'Theta V' },
  { value: 'thetaH', text: 'Theta H' },
  { value: 'thetaD', text: 'Theta D' },
  { value: 'albedo', text: 'ALBEDO' },
];

const SAMPLING_OPTIONS = [
  { value: '0', text: 'Cosine Sampling' },
  { value: '1', text: 'Uniform Sampling' },
  { value: '2', text: 'Polar Sampling' },
  { value: '3', text: 'BlinnPhong Sampling' },
  { value: '4', text: 'M.I. Sampling' },
];

const MODE_DESCRIPTIONS: Record<CartesianMode, string> = {
  thetaV:
    'Theta V: BRDF value versus signed outgoing/view theta. PhiV is in degrees; Disney defaults to Lock on, following incident phi.',
  thetaH:
    'Theta H: BRDF value versus half-vector angle thetaH while thetaD is fixed. This shows the lobe around the mirror/half-vector direction.',
  thetaD:
    'Theta D: BRDF value versus difference angle thetaD while thetaH is fixed. This shows falloff as light/view separate around a fixed half-vector.',
  albedo:
    'ALBEDO: hemispherical reflectance estimate versus incident theta. This is a Monte Carlo integration and is intentionally lower resolution than the angle slices.',
};

const MODE_INDEX: Record<CartesianMode, number> = {
  thetaV: 0,
  thetaH: 1,
  thetaD: 2,
  albedo: 3,
};

export class PlotCartesianView extends BaseView {
  private cache: BrdfProgramCache;
  private guides: Line2D;
  private vao: WebGLVertexArrayObject;

  private lookZoom = 1.0;
  private centerX = 0.4;
  private centerY = 0.5;
  private scaleX = 0.8;
  private scaleY = 1.0;
  private mode: CartesianMode = 'thetaV';
  private phiV = 0.0;
  private angleParam = 0.0;
  private nSamples = 2500;
  private samplingMode = 4;
  private albedoBoostFrames = 0;
  private lockPhiV = true;
  private syncUnsub: (() => void) | null = null;

  constructor(container: HTMLElement, store: Store) {
    super(
      container,
      store,
      'Theta V',
      MODE_DESCRIPTIONS.thetaV,
    );
    const gl = this.gl;
    this.phiV = store.state.incidentPhi;
    this.guides = new Line2D(gl);
    this.vao = createEmptyVAO(gl);
    this.renderControls();
    this.syncUnsub = store.subscribe(() => {
      if (this.mode !== 'thetaV' || !this.lockPhiV) return;
      const next = this.store.state.incidentPhi;
      if (Math.abs(next - this.phiV) < 0.00001) return;
      this.phiV = next;
      this.renderControls();
      this.requestRender();
    });
    this.setupInteraction();
    this.cache = new BrdfProgramCache(gl, 'cartesianPlot.vert', 'cartesianPlot.frag', 'Cartesian');
    this.cache.ready.then(() => this.requestRender()).catch((e) => console.error('cartesian templates', e));
  }

  private renderControls(): void {
    const description = MODE_DESCRIPTIONS[this.mode];
    this.setViewTitle(this.modeLabel(), description);

    const controls: HTMLElement[] = [
      selectControl(
        'Mode',
        MODE_OPTIONS,
        this.mode,
        (v) => {
          this.mode = v as CartesianMode;
          if (this.mode === 'thetaV' && this.lockPhiV) this.phiV = this.store.state.incidentPhi;
          this.angleParam = Math.max(0, Math.min(Math.PI / 2, this.angleParam));
          this.renderControls();
          this.requestRender();
        },
        'Switch between Disney Cartesian angle plots.',
      ),
    ];

    if (this.mode === 'thetaV') {
      controls.push(
        floatControl(
          'PhiV',
          radToDeg360(this.phiV),
          0,
          360,
          45,
          (v) => {
            this.phiV = degToRad(v);
            this.requestRender();
          },
          'Outgoing/view azimuth plane in degrees. Disabled while Lock follows the incident light phi.',
          this.lockPhiV,
        ),
        boolControl(
          'Lock',
          this.lockPhiV,
          (v) => {
            this.lockPhiV = v;
            if (this.lockPhiV) this.phiV = this.store.state.incidentPhi;
            this.renderControls();
            this.requestRender();
          },
          'Match Disney Theta V: keep phiV locked to the incident light phi.',
        ),
      );
    } else if (this.mode === 'thetaH') {
      controls.push(
        floatControl(
          'ThetaD',
          radToDeg360(this.angleParam),
          0,
          90,
          0,
          (v) => {
            this.angleParam = degToRad(v);
            this.requestRender();
          },
          'Fixed difference angle in degrees. The x-axis sweeps thetaH.',
        ),
      );
    } else if (this.mode === 'thetaD') {
      controls.push(
        floatControl(
          'ThetaH',
          radToDeg360(this.angleParam),
          0,
          90,
          0,
          (v) => {
            this.angleParam = degToRad(v);
            this.requestRender();
          },
          'Fixed half-vector angle in degrees. The x-axis sweeps thetaD.',
        ),
      );
    } else {
      controls.push(
        floatControl(
          'Samples',
          this.nSamples,
          1000,
          10000,
          2500,
          (v) => {
            this.nSamples = Math.round(v);
            this.requestRender();
          },
          'Base Monte Carlo sample count per incident angle. Resample x10 temporarily multiplies this for one redraw.',
        ),
        buttonControl(
          'Resample',
          'x10',
          () => {
            this.albedoBoostFrames = 1;
            this.requestRender();
          },
          'Render the ALBEDO estimate once with ten times the current sample count.',
        ),
        selectControl(
          'Sampling',
          SAMPLING_OPTIONS,
          String(this.samplingMode),
          (v) => {
            this.samplingMode = Number(v);
            this.requestRender();
          },
          'Monte Carlo sampling strategy for ALBEDO. M.I. Sampling matches Disney default.',
        ),
      );
    }

    this.footer.replaceChildren(...controls);
  }

  private modeLabel(): string {
    return MODE_OPTIONS.find((o) => o.value === this.mode)?.text ?? 'Theta V';
  }

  private projection(): Mat4 {
    const aspect = this.canvas.width / this.canvas.height;
    const z = this.lookZoom;
    return ortho(
      this.centerX - aspect * z,
      this.centerX + aspect * z,
      this.centerY - z,
      this.centerY + z,
      -1,
      1,
    );
  }

  protected draw(): void {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.clearColor(1, 1, 1, 1);
    gl.disable(gl.DEPTH_TEST);
    if (this.mode === 'albedo') {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.disable(gl.BLEND);
    }
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (w === 0 || h === 0) return;

    const proj = this.projection();
    const mv = scale(this.scaleX, this.scaleY, 1);
    const projMv = mul(proj, mv);

    this.drawGrid(projMv);

    const pkgs = this.store.packages();
    const s = this.store.state;
    gl.bindVertexArray(this.vao);
    for (const pkg of pkgs) {
      const prog = this.cache.get(pkg.instance.def);
      if (!prog) continue;
      const iv: [number, number, number] = [
        Math.sin(s.incidentTheta) * Math.cos(s.incidentPhi),
        Math.sin(s.incidentTheta) * Math.sin(s.incidentPhi),
        Math.cos(s.incidentTheta),
      ];
      gl.useProgram(prog.program);
      prog.u.m4('projectionMatrix', proj);
      prog.u.m4('modelViewMatrix', mv);
      prog.u.v3('incidentVector', iv[0], iv[1], iv[2]);
      prog.u.f('incidentPhi', s.incidentPhi);
      prog.u.f('phiV', this.phiV);
      prog.u.f('angleParam', this.angleParam);
      prog.u.i('plotMode', MODE_INDEX[this.mode]);
      prog.u.i('segmentCount', this.mode === 'albedo' ? ALBEDO_SEGMENTS : SEGMENTS);
      prog.u.i('nSamples', Math.max(1, Math.round(this.nSamples)));
      prog.u.f('sampleMultOn', this.albedoBoostFrames > 0 ? 1 : 0);
      prog.u.i('samplingMode', this.samplingMode);
      prog.u.f('useLogPlot', s.useLogPlot ? 1 : 0);
      prog.u.f('useNDotL', s.useNDotL ? 1 : 0);
      prog.u.v3('colorMask', pkg.colorMask[0], pkg.colorMask[1], pkg.colorMask[2]);
      prog.u.v2('viewport_size', w, h);
      prog.u.f('thickness', 3);
      prog.u.v3('drawColor', pkg.drawColor[0], pkg.drawColor[1], pkg.drawColor[2]);
      this.cache.applyParams(prog.u, pkg.instance);
      const segmentCount = this.mode === 'albedo' ? ALBEDO_SEGMENTS : SEGMENTS;
      gl.drawArrays(gl.TRIANGLES, 0, segmentCount * 6);
    }
    gl.bindVertexArray(null);
    if (this.albedoBoostFrames > 0) {
      this.albedoBoostFrames = 0;
    }
  }

  private drawGrid(projMv: Mat4): void {
    // model space: x = theta in [-pi/2, pi/2], y = brdf value (0..~)
    const pos: number[] = [];
    const col: number[] = [];
    const xMin = -Math.PI / 2;
    const xMax = Math.PI / 2;
    const push = (x0: number, y0: number, x1: number, y1: number, g: number) => {
      pos.push(x0, y0, x1, y1);
      col.push(g, g, g, g, g, g);
    };
    // horizontal gridlines y = 0.1 .. 1.0
    for (let i = 1; i <= 10; i++) push(xMin, i / 10, xMax, i / 10, 0.85);
    // vertical gridlines at integer theta
    for (let t = -1; t <= 1; t++) push(t, 0, t, 1, 0.85);
    // bold axes
    push(xMin, 0, xMax, 0, 0.4);
    push(0, 0, 0, 1, 0.4);

    this.guides.draw(projMv, new Float32Array(pos), new Float32Array(col), this.gl.LINES);
  }

  private setupInteraction(): void {
    const c = this.canvas;
    let lastX = 0;
    let lastY = 0;
    let button = -1;
    let ctrl = false;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      button = e.button;
      ctrl = e.ctrlKey || e.metaKey;
      lastX = e.clientX;
      lastY = e.clientY;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointerup', (e) => {
      button = -1;
      c.releasePointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (button < 0) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      const rect = c.getBoundingClientRect();
      if (ctrl) {
        // Ctrl+drag: adjust x/y scale (PlotCartesianWidget)
        if (button === 0) {
          this.scaleX += dx * this.scaleX * 0.01;
          this.scaleX = Math.max(0.01, Math.min(50, this.scaleX));
        } else {
          this.scaleY += dy * this.scaleY * 0.01;
          this.scaleY = Math.max(0.01, Math.min(50, this.scaleY));
        }
      } else if (button === 0) {
        const maxScalar = Math.max(1 / rect.width, 1 / rect.height);
        this.centerX += -dx * maxScalar * 2 * this.lookZoom;
        this.centerY += dy * maxScalar * 2 * this.lookZoom;
      } else if (button === 2) {
        const d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
        this.lookZoom -= d * this.lookZoom * 0.05;
        this.lookZoom = Math.max(0.01, Math.min(50, this.lookZoom));
      }
      this.requestRender();
    });
    c.addEventListener('dblclick', () => {
      this.lookZoom = 1.0;
      this.centerX = 0.4;
      this.centerY = 0.5;
      this.scaleX = 0.8;
      this.scaleY = 1.0;
      this.requestRender();
    });
  }

  override dispose(): void {
    this.syncUnsub?.();
    super.dispose();
  }
}

function buttonControl(
  label: string,
  text: string,
  onClick: () => void,
  description?: string,
): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-compact';
  button.textContent = text;
  if (description) button.title = description;
  button.addEventListener('click', onClick);
  return labeledRow(label, button, description);
}

function degToRad(degrees: number): number {
  return degrees * Math.PI / 180;
}

function radToDeg360(radians: number): number {
  const degrees = radians * 180 / Math.PI;
  return ((degrees % 360) + 360) % 360;
}
