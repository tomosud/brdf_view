// Polar Plot. Port of PlotPolarWidget: BRDF radius vs viewing angle over a
// half-disc, with normal/horizon/incident/reflection guides and a semicircle.
// Left-drag pans, right-drag zooms, double-click resets.

import { BaseView } from './base-view.js';
import { BrdfProgramCache } from '../gl/brdf-program.js';
import { Line2D } from '../gl/line2d.js';
import { createEmptyVAO } from '../gl/line-expansion.js';
import { ortho, type Mat4 } from '../gl/mat4.js';
import type { Store } from '../state/store.js';

const SEGMENTS = 360;
const C = 173 / 255;
const C2 = 226 / 255;

export class PlotPolarView extends BaseView {
  private cache: BrdfProgramCache;
  private guides: Line2D;
  private vao: WebGLVertexArrayObject;

  private lookZoom = 1.0;
  private centerX = 0;
  private centerY = 0.75;

  constructor(container: HTMLElement, store: Store) {
    super(container, store, 'Polar Plot');
    const gl = this.gl;
    this.guides = new Line2D(gl);
    this.vao = createEmptyVAO(gl);
    this.setupInteraction();
    this.cache = new BrdfProgramCache(gl, 'polarPlot.vert', 'polarPlot.frag', 'Polar');
    this.cache.ready.then(() => this.requestRender()).catch((e) => console.error('polar templates', e));
  }

  protected draw(): void {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.clearColor(1, 1, 1, 1);
    gl.disable(gl.DEPTH_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (w === 0 || h === 0) return;

    const aspect = w / h;
    const z = this.lookZoom;
    const proj = ortho(
      this.centerX - aspect * z,
      this.centerX + aspect * z,
      this.centerY - z,
      this.centerY + z,
      -1,
      1,
    );

    this.drawGuides(proj);

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
      prog.u.v3('incidentVector', iv[0], iv[1], iv[2]);
      prog.u.f('incidentPhi', s.incidentPhi);
      prog.u.f('useLogPlot', s.useLogPlot ? 1 : 0);
      prog.u.f('useNDotL', s.useNDotL ? 1 : 0);
      prog.u.v3('colorMask', pkg.colorMask[0], pkg.colorMask[1], pkg.colorMask[2]);
      prog.u.v2('viewport_size', w, h);
      prog.u.f('thickness', 3);
      prog.u.v3('drawColor', pkg.drawColor[0], pkg.drawColor[1], pkg.drawColor[2]);
      this.cache.applyParams(prog.u, pkg.instance);
      gl.drawArrays(gl.TRIANGLES, 0, SEGMENTS * 6);
    }
    gl.bindVertexArray(null);
  }

  private drawGuides(proj: Mat4): void {
    const theta = this.store.state.incidentTheta;
    const a = 1.57079633 - theta;
    const V = 2.0;
    // normal, horizon, incident, reflection
    const pos = new Float32Array([
      0, 0, 0, V, // normal
      -V, 0, V, 0, // horizon
      0, 0, -V * Math.cos(a), V * Math.sin(a), // incident
      0, 0, V * Math.cos(a), V * Math.sin(a), // reflection
    ]);
    const col = new Float32Array([
      C, 1, C, C, 1, C,
      0, 0, 0, 0, 0, 0,
      C, 1, 1, C, 1, 1,
      1, C, 1, 1, C, 1,
    ]);
    this.guides.draw(proj, pos, col, this.gl.LINES);

    // semicircle guide (0..pi)
    const n = 181;
    const sp = new Float32Array(n * 2);
    const sc = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const ang = (Math.PI / 180) * i;
      sp[i * 2] = Math.cos(ang);
      sp[i * 2 + 1] = Math.sin(ang);
      sc[i * 3] = C2;
      sc[i * 3 + 1] = C2;
      sc[i * 3 + 2] = C;
    }
    this.guides.draw(proj, sp, sc, this.gl.LINE_STRIP);
  }

  private setupInteraction(): void {
    const c = this.canvas;
    let lastX = 0;
    let lastY = 0;
    let button = -1;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      button = e.button;
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
      if (button === 0) {
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
      this.centerX = 0;
      this.centerY = 0.75;
      this.requestRender();
    });
  }
}
