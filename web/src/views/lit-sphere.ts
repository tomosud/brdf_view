// Lit Sphere. Port of LitSphereWidget: an orthographic sphere lit by a single
// directional light from the (optionally doubled) incident direction, using the
// topmost enabled BRDF. Left-drag on the sphere sets the global incident angle;
// brightness/gamma/exposure/doubleTheta/useNDotL are local controls.

import { BaseView } from './base-view.js';
import { BrdfProgramCache } from '../gl/brdf-program.js';
import { buildSphere } from '../gl/mesh.js';
import { ortho, lookAt } from '../gl/mat4.js';
import { floatControl, boolControl } from '../ui/controls.js';
import type { Store } from '../state/store.js';

const SPHERE_MARGIN = 1.1;
const NEAR_PLANE = 0.5;
const FAR_PLANE = 50.0;
const VIEW_GRAY_SRGB = 0.5;

export class LitSphereView extends BaseView {
  private cache: BrdfProgramCache;
  private posVBO: WebGLBuffer;
  private idxVBO: WebGLBuffer;
  private indexCount: number;

  // local controls (LitSphereWidget defaults)
  private brightness = 1.0;
  private gamma = 2.2;
  private exposure = 0.0;
  private doubleTheta = true;
  private useNDotL = true;

  constructor(container: HTMLElement, store: Store) {
    super(container, store, 'Lit Sphere');
    const gl = this.gl;

    const sphere = buildSphere(1.0, 100, 100);
    this.indexCount = sphere.indices.length;
    this.posVBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posVBO);
    gl.bufferData(gl.ARRAY_BUFFER, sphere.positions, gl.STATIC_DRAW);
    this.idxVBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxVBO);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sphere.indices, gl.STATIC_DRAW);

    this.buildControls();
    this.setupInteraction();

    this.cache = new BrdfProgramCache(gl, 'brdftemplatesphere.vert', 'brdftemplatesphere.frag', 'Sphere');
    this.cache.ready.then(() => this.requestRender()).catch((e) => console.error('sphere templates', e));
  }

  protected draw(): void {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.clearColor(VIEW_GRAY_SRGB, VIEW_GRAY_SRGB, VIEW_GRAY_SRGB, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (w === 0 || h === 0) return;

    const pkg = this.store.topmostEnabled();
    if (!pkg) return;
    const prog = this.cache.get(pkg.instance.def);
    if (!prog) return;

    // orthographic projection, matching LitSphereWidget aspect handling
    const m = SPHERE_MARGIN;
    const proj =
      w > h
        ? ortho((-w / h) * m, (w / h) * m, -m, m, NEAR_PLANE, FAR_PLANE)
        : ortho(-m, m, (-h / w) * m, (h / w) * m, NEAR_PLANE, FAR_PLANE);
    const mv = lookAt([0, 0, 2.75], [0, 0, 0], [0, 1, 0]);

    const s = this.store.state;
    const useTheta = this.doubleTheta ? s.incidentTheta * 2 : s.incidentTheta;
    const iv: [number, number, number] = [
      Math.sin(useTheta) * Math.cos(s.incidentPhi),
      Math.sin(useTheta) * Math.sin(s.incidentPhi),
      Math.cos(useTheta),
    ];

    gl.useProgram(prog.program);
    prog.u.m4('projectionMatrix', proj);
    prog.u.m4('modelViewMatrix', mv);
    prog.u.v3('incidentVector', iv[0], iv[1], iv[2]);
    prog.u.f('incidentTheta', s.incidentTheta);
    prog.u.f('incidentPhi', s.incidentPhi);
    prog.u.f('brightness', this.brightness);
    prog.u.f('gamma', this.gamma);
    prog.u.f('exposure', this.exposure);
    prog.u.f('useNDotL', this.useNDotL ? 1 : 0);
    this.cache.applyParams(prog.u, pkg.instance);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posVBO);
    gl.enableVertexAttribArray(prog.posLoc);
    gl.vertexAttribPointer(prog.posLoc, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxVBO);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
  }

  private buildControls(): void {
    this.footer.append(
      floatControl('Brightness', this.brightness, 0, 10, 1, (v) => {
        this.brightness = v;
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
      boolControl('Double θ', this.doubleTheta, (v) => {
        this.doubleTheta = v;
        this.requestRender();
      }),
      boolControl('Use N·L', this.useNDotL, (v) => {
        this.useNDotL = v;
        this.requestRender();
      }),
    );
  }

  private setupInteraction(): void {
    const c = this.canvas;
    let down = false;
    const update = (e: PointerEvent) => {
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const cx = rect.width * 0.5;
      const cy = rect.height * 0.5;
      const radius = (rect.height > rect.width ? rect.width : rect.height) * 0.5 / SPHERE_MARGIN;
      let x = mx - cx;
      let y = my - cy;
      if (Math.hypot(x, y) > radius) return;
      x /= radius;
      y /= radius;
      const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
      // toThetaPhi (LitSphereWidget): note phi sign convention
      const theta = Math.acos(z / Math.hypot(x, y, z));
      let phi = Math.atan2(y, x);
      phi = phi < 0 ? -phi : 6.28318531 - phi;
      this.store.patch({ incidentTheta: theta, incidentPhi: phi });
    };
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      down = true;
      c.setPointerCapture(e.pointerId);
      update(e);
    });
    c.addEventListener('pointermove', (e) => down && update(e));
    c.addEventListener('pointerup', (e) => {
      down = false;
      c.releasePointerCapture(e.pointerId);
    });
  }
}
