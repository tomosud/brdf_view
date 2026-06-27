// 3D Plot (reflectometer). Port of Plot3DWidget: a tessellated hemisphere whose
// vertices are displaced radially by the BRDF value, plus incident/normal/
// reflection/U/V direction lines and the unit circle. Left drag orbits, right
// drag zooms, double-click resets.

import { BaseView } from './base-view.js';
import { buildProgram, Uniforms } from '../gl/renderer.js';
import { BrdfProgramCache } from '../gl/brdf-program.js';
import { buildHemisphere, unitCircle, directionLines } from '../gl/mesh.js';
import { perspective, lookAt, DEG2RAD, type Mat4 } from '../gl/mat4.js';
import type { Store } from '../state/store.js';

const LINE_VERT = `#version 300 es
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
in vec3 vtx_position;
in vec3 vtx_color;
out vec3 v_color;
void main() {
  v_color = vtx_color;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(vtx_position, 1.0);
}`;

const LINE_FRAG = `#version 300 es
precision highp float;
in vec3 v_color;
out vec4 fragColor;
void main() { fragColor = vec4(v_color, 1.0); }`;

const FOV_Y = 45.0;

export class Plot3DView extends BaseView {
  private cache: BrdfProgramCache;

  private hemiVBO: WebGLBuffer;
  private hemiCount: number;
  private circleVBO: WebGLBuffer;
  private dirVBO: WebGLBuffer; // interleaved pos(3)+col(3)
  private circleColVBO: WebGLBuffer;
  private lineProgram: WebGLProgram;
  private lineU: Uniforms;
  private linePos: number;
  private lineCol: number;

  // viewing params (Plot3DWidget defaults)
  private lookPhi = 0;
  private lookTheta = 0.785398163;
  private lookZoom = 4.0;
  private lastDirKey = '';

  constructor(container: HTMLElement, store: Store) {
    super(
      container,
      store,
      '3D Plot',
      'Fixed incident light; each outgoing/view direction is displaced by BRDF value. Optional N.L shows reflected radiance shape.',
    );
    const gl = this.gl;

    const hemi = buildHemisphere(6);
    this.hemiCount = hemi.triangleCount * 3;
    this.hemiVBO = this.makeBuffer(hemi.positions);

    this.circleVBO = this.makeBuffer(unitCircle(60));
    const circleColors = new Float32Array(60 * 3).fill(0);
    for (let i = 0; i < 60; i++) { circleColors[i * 3] = 0.8; circleColors[i * 3 + 1] = 0.8; }
    this.circleColVBO = this.makeBuffer(circleColors);

    this.dirVBO = gl.createBuffer()!;

    this.lineProgram = buildProgram(gl, LINE_VERT, LINE_FRAG, 'line3d');
    this.lineU = new Uniforms(gl, this.lineProgram);
    this.linePos = gl.getAttribLocation(this.lineProgram, 'vtx_position');
    this.lineCol = gl.getAttribLocation(this.lineProgram, 'vtx_color');

    this.setupInteraction();

    this.cache = new BrdfProgramCache(gl, 'brdftemplate3D.vert', 'brdftemplate3D.frag', '3D');
    this.cache.ready.then(() => this.requestRender()).catch((e) => console.error('3D templates', e));
  }

  private makeBuffer(data: Float32Array): WebGLBuffer {
    const gl = this.gl;
    const b = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return b;
  }

  protected draw(): void {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.clearColor(0.5, 0.5, 0.5, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (h === 0) return;

    const near = Math.min(this.lookZoom * 0.1, 0.5);
    const far = Math.min(this.lookZoom * 10.0, 100.0);
    const proj = perspective(FOV_Y * DEG2RAD, w / h, near, far);
    const eye: [number, number, number] = [
      Math.sin(this.lookTheta) * Math.cos(this.lookPhi) * this.lookZoom,
      Math.sin(this.lookTheta) * Math.sin(this.lookPhi) * this.lookZoom,
      Math.cos(this.lookTheta) * this.lookZoom,
    ];
    const mv = lookAt(eye, [0, 0, 0], [0, 0, 1]);

    const s = this.store.state;
    const pkgs = this.store.packages();
    for (const pkg of pkgs) {
      const prog = this.cache.get(pkg.instance.def);
      if (!prog) continue;
      gl.useProgram(prog.program);
      prog.u.m4('projectionMatrix', proj);
      prog.u.m4('modelViewMatrix', mv);
      const iv: [number, number, number] = [
        Math.sin(s.incidentTheta) * Math.cos(s.incidentPhi),
        Math.sin(s.incidentTheta) * Math.sin(s.incidentPhi),
        Math.cos(s.incidentTheta),
      ];
      prog.u.v3('incidentVector', iv[0], iv[1], iv[2]);
      prog.u.f('incidentTheta', s.incidentTheta);
      prog.u.f('incidentPhi', s.incidentPhi);
      prog.u.f('useLogPlot', s.useLogPlot ? 1 : 0);
      prog.u.f('useNDotL', s.useNDotL ? 1 : 0);
      prog.u.v3('drawColor', pkg.drawColor[0], pkg.drawColor[1], pkg.drawColor[2]);
      prog.u.v3('colorMask', pkg.colorMask[0], pkg.colorMask[1], pkg.colorMask[2]);
      this.cache.applyParams(prog.u, pkg.instance);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.hemiVBO);
      gl.enableVertexAttribArray(prog.posLoc);
      gl.vertexAttribPointer(prog.posLoc, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, this.hemiCount);
    }

    this.drawLines(proj, mv);
  }

  private drawLines(proj: Mat4, mv: Mat4): void {
    const gl = this.gl;
    const s = this.store.state;
    const key = `${s.incidentTheta},${s.incidentPhi}`;
    if (key !== this.lastDirKey) {
      const dl = directionLines(s.incidentTheta, s.incidentPhi);
      const inter = new Float32Array(dl.vertexCount * 6);
      for (let i = 0; i < dl.vertexCount; i++) {
        inter.set(dl.positions.subarray(i * 3, i * 3 + 3), i * 6);
        inter.set(dl.colors.subarray(i * 3, i * 3 + 3), i * 6 + 3);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.dirVBO);
      gl.bufferData(gl.ARRAY_BUFFER, inter, gl.DYNAMIC_DRAW);
      this.lastDirKey = key;
    }

    gl.useProgram(this.lineProgram);
    this.lineU.m4('projectionMatrix', proj);
    this.lineU.m4('modelViewMatrix', mv);

    // direction lines (interleaved pos+col, stride 24)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dirVBO);
    gl.enableVertexAttribArray(this.linePos);
    gl.vertexAttribPointer(this.linePos, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(this.lineCol);
    gl.vertexAttribPointer(this.lineCol, 3, gl.FLOAT, false, 24, 12);
    gl.drawArrays(gl.LINES, 0, 10);

    // unit circle (separate pos + color buffers)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.circleVBO);
    gl.vertexAttribPointer(this.linePos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.circleColVBO);
    gl.vertexAttribPointer(this.lineCol, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.LINE_LOOP, 0, 60);
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
        this.lookPhi += -dx * 0.01;
        this.lookTheta += -dy * 0.01;
        this.lookTheta = Math.max(0.001, Math.min(Math.PI / 2, this.lookTheta));
      } else if (button === 2) {
        const d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
        this.lookZoom -= d * this.lookZoom * 0.05;
        this.lookZoom = Math.max(0.01, Math.min(100, this.lookZoom));
      }
      this.requestRender();
    });
    c.addEventListener('dblclick', () => {
      this.lookPhi = 0;
      this.lookTheta = 0.785398163;
      this.lookZoom = 4.0;
      this.requestRender();
    });
  }
}
