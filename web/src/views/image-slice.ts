// Image Slice. Port of ImageSliceWidget: a 2D image of the topmost-enabled BRDF
// over (thetaH, thetaD) in [0, pi/2] at a fixed phiD. Works for analytic and
// measured (MERL) BRDFs. Controls: phiD, gamma, exposure, Square ThetaH, Show
// Chroma (brightness is fixed at 1, matching the original's slice window).

import { BaseView } from './base-view.js';
import { BrdfProgramCache } from '../gl/brdf-program.js';
import { createEmptyVAO } from '../gl/line-expansion.js';
import { floatControl, boolControl } from '../ui/controls.js';
import type { Store } from '../state/store.js';

const DEG2RAD = Math.PI / 180;

export class ImageSliceView extends BaseView {
  private cache: BrdfProgramCache;
  private vao: WebGLVertexArrayObject;

  private phiDdeg = 90;
  private gamma = 2.2;
  private exposure = 0.0;
  private useThetaHSquared = false;
  private showChroma = false;

  constructor(container: HTMLElement, store: Store) {
    super(container, store, 'Image Slice');
    const gl = this.gl;
    this.vao = createEmptyVAO(gl);
    this.buildControls();
    this.cache = new BrdfProgramCache(gl, 'imageSlice.vert', 'imageSlice.frag', 'Slice');
    this.cache.ready.then(() => this.requestRender()).catch((e) => console.error('slice templates', e));
  }

  protected draw(): void {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.clearColor(0.15, 0.15, 0.15, 1);
    gl.disable(gl.DEPTH_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (w === 0 || h === 0) return;

    // centered square viewport so the slice stays square regardless of aspect
    const s = Math.min(w, h);
    gl.viewport((w - s) >> 1, (h - s) >> 1, s, s);

    const pkg = this.store.topmostEnabled();
    if (!pkg) return;
    const prog = this.cache.get(pkg.instance.def);
    if (!prog) return;

    gl.useProgram(prog.program);
    prog.u.f('incidentPhi', this.store.state.incidentPhi);
    prog.u.f('phiD', this.phiDdeg * DEG2RAD);
    prog.u.f('brightness', 1.0);
    prog.u.f('gamma', this.gamma);
    prog.u.f('exposure', this.exposure);
    prog.u.f('showChroma', this.showChroma ? 1 : 0);
    prog.u.f('useThetaHSquared', this.useThetaHSquared ? 1 : 0);
    prog.u.f('useNDotL', 0);
    this.cache.applyParams(prog.u, pkg.instance);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);

    gl.viewport(0, 0, w, h);
  }

  private buildControls(): void {
    this.footer.append(
      floatControl('phiD°', this.phiDdeg, 0, 180, 90, (v) => {
        this.phiDdeg = v;
        this.requestRender();
      }),
      floatControl('Gamma', this.gamma, 0.1, 5, 2.2, (v) => {
        this.gamma = v;
        this.requestRender();
      }),
      floatControl('Exposure', this.exposure, -10, 10, 0, (v) => {
        this.exposure = v;
        this.requestRender();
      }),
      boolControl('Square ThetaH', this.useThetaHSquared, (v) => {
        this.useThetaHSquared = v;
        this.requestRender();
      }),
      boolControl('Show Chroma', this.showChroma, (v) => {
        this.showChroma = v;
        this.requestRender();
      }),
    );
  }
}
