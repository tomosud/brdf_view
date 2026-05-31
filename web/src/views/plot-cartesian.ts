// Cartesian Plot (Theta V). Port of PlotCartesianWidget for the THETA_V slice:
// x = viewing theta in [-pi/2, pi/2], y = BRDF value, with a light grid and bold
// axes. Left-drag pans, right-drag zooms, Ctrl+drag changes x/y scale,
// double-click resets. The phiV angle parameter is a footer control.
//
// Remaining (documented follow-up): THETA_H (theta-squared sample concentration),
// THETA_D, and ALBEDO (Monte-Carlo albedo integration with multiple sampling
// strategies). These need the mode-variant vector synthesis / sampling kernels.

import { BaseView } from './base-view.js';
import { BrdfProgramCache } from '../gl/brdf-program.js';
import { Line2D } from '../gl/line2d.js';
import { createEmptyVAO } from '../gl/line-expansion.js';
import { ortho, scale, mul, type Mat4 } from '../gl/mat4.js';
import { floatControl } from '../ui/controls.js';
import type { Store } from '../state/store.js';

const SEGMENTS = 512;

export class PlotCartesianView extends BaseView {
  private cache: BrdfProgramCache;
  private guides: Line2D;
  private vao: WebGLVertexArrayObject;

  private lookZoom = 1.0;
  private centerX = 0.4;
  private centerY = 0.5;
  private scaleX = 0.8;
  private scaleY = 1.0;
  private phiV = 0.0;

  constructor(container: HTMLElement, store: Store) {
    super(container, store, 'Theta V');
    const gl = this.gl;
    this.guides = new Line2D(gl);
    this.vao = createEmptyVAO(gl);
    this.footer.append(
      floatControl('phiV', this.phiV, -Math.PI, Math.PI, 0, (v) => {
        this.phiV = v;
        this.requestRender();
      }),
    );
    this.setupInteraction();
    this.cache = new BrdfProgramCache(gl, 'cartesianPlot.vert', 'cartesianPlot.frag', 'Cartesian');
    this.cache.ready.then(() => this.requestRender()).catch((e) => console.error('cartesian templates', e));
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
}
