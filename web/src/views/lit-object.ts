// Lit Object (IBL). Port of IBLWidget for the equirect-HDRI path: an object
// (sphere default; OBJ loader is future work) shaded by the environment, over an
// environment background. Modes: "No IBL" (directional light) and "IBL"
// (cosine-weighted Monte-Carlo). Importance sampling (IBL IS/MIS) is future work.
// Left-drag orbits, right-drag zooms, double-click resets.

import { BaseView } from './base-view.js';
import { BrdfProgramCache } from '../gl/brdf-program.js';
import { buildProgram, Uniforms } from '../gl/renderer.js';
import { loadTemplate } from '../brdf/shader-builder.js';
import { uploadEnv, type EnvTexture } from '../gl/env-texture.js';
import { buildSphere } from '../gl/mesh.js';
import { perspective, lookAt, DEG2RAD } from '../gl/mat4.js';
import { floatControl, selectControl } from '../ui/controls.js';
import type { HdrImage } from '../io/hdr.js';
import type { Store } from '../state/store.js';

const FOV_Y = 45.0;

export class LitObjectView extends BaseView {
  private cache: BrdfProgramCache;
  private env: EnvTexture;
  private bg: { program: WebGLProgram; u: Uniforms } | null = null;
  private posVBO: WebGLBuffer;
  private idxVBO: WebGLBuffer;
  private indexCount: number;
  private emptyVAO: WebGLVertexArrayObject;

  private lookTheta = 1.2;
  private lookPhi = 0.6;
  private lookZoom = 1.0;
  private renderWithIBL = true;
  private gamma = 2.2;
  private exposure = 0.0;
  private numSamples = 128;

  constructor(container: HTMLElement, store: Store, envImg: HdrImage) {
    super(container, store, 'Lit Object');
    const gl = this.gl;

    this.env = uploadEnv(gl, envImg);

    const sphere = buildSphere(1.0, 100, 100);
    this.indexCount = sphere.indices.length;
    this.posVBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posVBO);
    gl.bufferData(gl.ARRAY_BUFFER, sphere.positions, gl.STATIC_DRAW);
    this.idxVBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxVBO);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sphere.indices, gl.STATIC_DRAW);
    this.emptyVAO = gl.createVertexArray()!;

    this.buildControls();
    this.setupInteraction();

    this.cache = new BrdfProgramCache(gl, 'iblObject.vert', 'iblObject.frag', 'IBL');
    const bgReady = Promise.all([loadTemplate('iblBackground.vert'), loadTemplate('iblBackground.frag')])
      .then(([v, f]) => {
        const program = buildProgram(gl, v, f, 'iblBackground');
        this.bg = { program, u: new Uniforms(gl, program) };
      });
    Promise.all([this.cache.ready, bgReady]).then(() => this.requestRender()).catch((e) =>
      console.error('IBL templates', e),
    );
  }

  private camera() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const aspect = w / h;
    const dist = 3.0 * this.lookZoom;
    const eye: [number, number, number] = [
      Math.sin(this.lookTheta) * Math.cos(this.lookPhi) * dist,
      Math.cos(this.lookTheta) * dist,
      Math.sin(this.lookTheta) * Math.sin(this.lookPhi) * dist,
    ];
    const proj = perspective(FOV_Y * DEG2RAD, aspect, 0.1, 100);
    const view = lookAt(eye, [0, 0, 0], [0, 1, 0]);

    // camera basis for the background ray (forward/right/up, scaled)
    const f = norm([-eye[0], -eye[1], -eye[2]]);
    const r = norm(cross(f, [0, 1, 0]));
    const u = cross(r, f);
    const t = Math.tan((FOV_Y * DEG2RAD) / 2);
    return {
      proj,
      view,
      eye,
      camForward: f,
      camRight: scaleV(r, t * aspect),
      camUp: scaleV(u, t),
    };
  }

  protected draw(): void {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (w === 0 || h === 0 || !this.bg) return;

    const cam = this.camera();

    // background (env), behind everything
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.useProgram(this.bg.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.env.texture);
    this.bg.u.i('envMap', 0);
    this.bg.u.v3('camForward', ...cam.camForward);
    this.bg.u.v3('camRight', ...cam.camRight);
    this.bg.u.v3('camUp', ...cam.camUp);
    this.bg.u.f('gamma', this.gamma);
    this.bg.u.f('exposure', this.exposure);
    this.bg.u.f('envIntensity', 1.0);
    gl.bindVertexArray(this.emptyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    // object
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    const pkg = this.store.topmostEnabled();
    if (!pkg) return;
    const prog = this.cache.get(pkg.instance.def);
    if (!prog) return;

    const s = this.store.state;
    const iv: [number, number, number] = [
      Math.sin(s.incidentTheta) * Math.cos(s.incidentPhi),
      Math.sin(s.incidentTheta) * Math.sin(s.incidentPhi),
      Math.cos(s.incidentTheta),
    ];
    gl.useProgram(prog.program);
    prog.u.m4('projectionMatrix', cam.proj);
    prog.u.m4('viewMatrix', cam.view);
    prog.u.v3('cameraPos', ...cam.eye);
    prog.u.v3('incidentVector', iv[0], iv[1], iv[2]);
    prog.u.f('gamma', this.gamma);
    prog.u.f('exposure', this.exposure);
    prog.u.f('useNDotL', s.useNDotL ? 1 : 0);
    prog.u.f('renderWithIBL', this.renderWithIBL ? 1 : 0);
    prog.u.f('envIntensity', 1.0);
    prog.u.i('numSamples', this.numSamples);
    // env on unit 1 (unit 0 may be used by measured BRDF data)
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.env.texture);
    prog.u.i('envMap', 1);
    this.cache.applyParams(prog.u, pkg.instance);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posVBO);
    gl.enableVertexAttribArray(prog.posLoc);
    gl.vertexAttribPointer(prog.posLoc, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxVBO);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
  }

  private buildControls(): void {
    this.footer.append(
      selectControl(
        'Mode',
        [
          { value: 'ibl', text: 'IBL (cosine)' },
          { value: 'none', text: 'No IBL' },
        ],
        'ibl',
        (v) => {
          this.renderWithIBL = v === 'ibl';
          this.requestRender();
        },
      ),
      floatControl('Samples', this.numSamples, 16, 1024, 128, (v) => {
        this.numSamples = Math.round(v);
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
    );
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
      if (button === 0) {
        this.lookPhi += dx * 0.01;
        this.lookTheta += -dy * 0.01;
        this.lookTheta = Math.max(0.05, Math.min(Math.PI - 0.05, this.lookTheta));
      } else if (button === 2) {
        const d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
        this.lookZoom -= d * this.lookZoom * 0.01;
        this.lookZoom = Math.max(0.2, Math.min(5, this.lookZoom));
      }
      this.requestRender();
    });
    c.addEventListener('dblclick', () => {
      this.lookTheta = 1.2;
      this.lookPhi = 0.6;
      this.lookZoom = 1.0;
      this.requestRender();
    });
  }
}

type V3 = [number, number, number];
function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function scaleV(v: V3, s: number): V3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}
