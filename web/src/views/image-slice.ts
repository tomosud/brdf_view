// Image Slice. Port of ImageSliceWidget: a 2D image of the topmost-enabled BRDF
// over (thetaH, thetaD) in [0, pi/2] at a fixed phiD. Works for analytic and
// measured (MERL) BRDFs. Controls: phiD, gamma, exposure, Square ThetaH, Show
// Chroma (brightness is fixed at 1, matching the original's slice window).

import { BaseView } from './base-view.js';
import { BrdfProgramCache } from '../gl/brdf-program.js';
import { buildProgram, Uniforms } from '../gl/renderer.js';
import { createEmptyVAO } from '../gl/line-expansion.js';
import { perspective, lookAt, DEG2RAD } from '../gl/mat4.js';
import { floatControl, boolControl, selectControl } from '../ui/controls.js';
import type { Store } from '../state/store.js';

const SURFACE_VERTICES = 96 * 96 * 6;

interface SliceTarget {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
  floatBacked: boolean;
}

export class ImageSliceView extends BaseView {
  private rawCache: BrdfProgramCache;
  private surfaceCache: BrdfProgramCache;
  private display: { program: WebGLProgram; u: Uniforms };
  private vao: WebGLVertexArrayObject;
  private target: SliceTarget | null = null;
  private floatTarget = false;
  private mode: 'image' | 'surface' = 'image';
  private readout: HTMLElement | null = null;

  private phiDdeg = 90;
  private gamma = 2.2;
  private exposure = 0.0;
  private useThetaHSquared = false;
  private showChroma = false;
  private heightScale = 0.065;
  private surfaceZoom = 1.0;

  constructor(container: HTMLElement, store: Store) {
    super(container, store, 'Image Slice');
    const gl = this.gl;
    this.floatTarget = !!gl.getExtension('EXT_color_buffer_float');
    this.vao = createEmptyVAO(gl);
    const displayProgram = buildProgram(gl, DISPLAY_VERT, DISPLAY_FRAG, 'imageSliceDisplay');
    this.display = { program: displayProgram, u: new Uniforms(gl, displayProgram) };
    this.buildControls();
    this.setupReadout();
    this.rawCache = new BrdfProgramCache(gl, 'imageSlice.vert', 'imageSliceRaw.frag', 'SliceRaw');
    this.surfaceCache = new BrdfProgramCache(gl, 'imageSliceSurface.vert', 'imageSliceSurface.frag', 'SliceSurface');
    Promise.all([this.rawCache.ready, this.surfaceCache.ready])
      .then(() => this.requestRender())
      .catch((e) => console.error('slice templates', e));
  }

  protected draw(): void {
    if (this.mode === 'surface') this.drawSurface();
    else this.drawImage();
  }

  private drawImage(): void {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.clearColor(0.5, 0.5, 0.5, 1);
    gl.disable(gl.DEPTH_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (w === 0 || h === 0) return;

    // centered square viewport so the slice stays square regardless of aspect
    const s = Math.min(w, h);
    this.ensureTarget(s);

    const pkg = this.store.topmostEnabled();
    if (!pkg) return;
    const prog = this.rawCache.get(pkg.instance.def);
    if (!prog) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target!.framebuffer);
    gl.viewport(0, 0, s, s);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog.program);
    this.applySliceUniforms(prog.u);
    this.rawCache.applyParams(prog.u, pkg.instance);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport((w - s) >> 1, (h - s) >> 1, s, s);
    gl.useProgram(this.display.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.target!.texture);
    this.display.u.i('sourceTex', 0);
    this.display.u.f('gamma', this.gamma);
    this.display.u.f('showChroma', this.showChroma ? 1 : 0);
    this.display.u.f('useLogPlot', this.store.state.useLogPlot ? 1 : 0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.viewport(0, 0, w, h);
  }

  private drawSurface(): void {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.5, 0.5, 0.5, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (w === 0 || h === 0) return;

    const pkg = this.store.topmostEnabled();
    if (!pkg) return;
    const prog = this.surfaceCache.get(pkg.instance.def);
    if (!prog) return;

    const proj = perspective(42 * DEG2RAD, w / h, 0.1, 20);
    const z = this.surfaceZoom;
    const mv = lookAt([2.35 * z, 1.6 * z, 2.35 * z], [0, 0.28, 0], [0, 1, 0]);

    gl.useProgram(prog.program);
    prog.u.m4('projectionMatrix', proj);
    prog.u.m4('modelViewMatrix', mv);
    this.applySliceUniforms(prog.u);
    prog.u.f('gamma', this.gamma);
    prog.u.f('showChroma', this.showChroma ? 1 : 0);
    prog.u.f('heightScale', this.heightScale);
    prog.u.f('useLogPlot', this.store.state.useLogPlot ? 1 : 0);
    this.surfaceCache.applyParams(prog.u, pkg.instance);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, SURFACE_VERTICES);
    gl.bindVertexArray(null);
  }

  private applySliceUniforms(u: Uniforms): void {
    u.f('incidentPhi', this.store.state.incidentPhi);
    u.f('phiD', this.phiDdeg * DEG2RAD);
    u.f('exposure', this.exposure);
    u.f('useThetaHSquared', this.useThetaHSquared ? 1 : 0);
    u.f('useNDotL', 0);
  }

  private ensureTarget(size: number): void {
    if (this.target?.width === size && this.target.height === size) return;
    if (this.target) {
      this.gl.deleteFramebuffer(this.target.framebuffer);
      this.gl.deleteTexture(this.target.texture);
    }
    this.target = createSliceTarget(this.gl, size, size, this.floatTarget);
  }

  private buildControls(): void {
    const readoutRow = document.createElement('div');
    readoutRow.className = 'ctl-row image-readout compact-wide';
    const readoutLabel = document.createElement('span');
    readoutLabel.className = 'ctl-label';
    readoutLabel.textContent = 'HDR';
    this.readout = document.createElement('span');
    this.readout.className = 'ctl-value';
    this.readout.textContent = this.floatTarget ? '-' : 'unavailable';
    readoutRow.append(readoutLabel, this.readout);

    const checks = document.createElement('div');
    checks.className = 'compact-checks';
    checks.append(
      boolControl('Square ThetaH', this.useThetaHSquared, (v) => {
        this.useThetaHSquared = v;
        this.requestRender();
      }),
      boolControl('Show Chroma', this.showChroma, (v) => {
        this.showChroma = v;
        this.requestRender();
      }),
    );

    const grid = document.createElement('div');
    grid.className = 'compact-controls image-slice-controls';
    grid.append(
      selectControl(
        'Mode',
        [
          { value: 'image', text: 'Image' },
          { value: 'surface', text: '3D Height' },
        ],
        this.mode,
        (v) => {
          this.mode = v as 'image' | 'surface';
          this.requestRender();
        },
      ),
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
      floatControl('Height', this.heightScale, 0.005, 0.25, 0.065, (v) => {
        this.heightScale = v;
        this.requestRender();
      }),
      checks,
      readoutRow,
    );
    this.footer.append(grid);
  }

  private setupReadout(): void {
    this.canvas.addEventListener('pointermove', (e) => this.updateReadout(e));
    this.canvas.addEventListener('pointerleave', () => {
      if (this.readout) this.readout.textContent = this.floatTarget ? '-' : 'unavailable';
    });
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        if (this.mode !== 'surface') return;
        e.preventDefault();
        this.surfaceZoom *= Math.exp(e.deltaY * 0.001);
        this.surfaceZoom = Math.max(0.35, Math.min(4.0, this.surfaceZoom));
        this.requestRender();
      },
      { passive: false },
    );
  }

  private updateReadout(e: PointerEvent): void {
    if (!this.readout || !this.target || this.mode !== 'image') return;
    const rect = this.canvas.getBoundingClientRect();
    const dprX = this.canvas.width / rect.width;
    const dprY = this.canvas.height / rect.height;
    const px = (e.clientX - rect.left) * dprX;
    const py = (e.clientY - rect.top) * dprY;
    const s = Math.min(this.canvas.width, this.canvas.height);
    const vx = (this.canvas.width - s) * 0.5;
    const vy = (this.canvas.height - s) * 0.5;
    if (px < vx || py < vy || px >= vx + s || py >= vy + s) {
      this.readout.textContent = '-';
      return;
    }

    const x = Math.max(0, Math.min(this.target.width - 1, Math.floor(px - vx)));
    const y = Math.max(0, Math.min(this.target.height - 1, Math.floor(s - 1 - (py - vy))));
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target.framebuffer);
    if (this.target.floatBacked) {
      const pixel = new Float32Array(4);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, pixel);
      this.readout.textContent = `R ${fmt(pixel[0])}  G ${fmt(pixel[1])}  B ${fmt(pixel[2])}`;
    } else {
      const pixel = new Uint8Array(4);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      this.readout.textContent = `R ${(pixel[0] / 255).toFixed(3)}  G ${(pixel[1] / 255).toFixed(3)}  B ${(pixel[2] / 255).toFixed(3)}`;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return 'nan';
  if (Math.abs(v) >= 1000 || (Math.abs(v) > 0 && Math.abs(v) < 0.001)) return v.toExponential(2);
  return v.toFixed(4);
}

function createSliceTarget(gl: WebGL2RenderingContext, width: number, height: number, useFloat: boolean): SliceTarget {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) throw new Error('failed to create image slice target');

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    useFloat ? gl.RGBA32F : gl.RGBA8,
    width,
    height,
    0,
    gl.RGBA,
    useFloat ? gl.FLOAT : gl.UNSIGNED_BYTE,
    null,
  );

  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteTexture(texture);
    gl.deleteFramebuffer(framebuffer);
    throw new Error(`image slice framebuffer incomplete: ${status}`);
  }

  return { framebuffer, texture, width, height, floatBacked: useFloat };
}

const DISPLAY_VERT = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const DISPLAY_FRAG = `#version 300 es
precision highp float;
uniform sampler2D sourceTex;
uniform float gamma;
uniform float showChroma;
uniform float useLogPlot;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec3 b = texture(sourceTex, vUv).rgb;
  if (showChroma != 0.0) {
    float nrm = max(b.r, max(b.g, b.b));
    if (nrm > 0.0) b /= nrm;
  }
  if (useLogPlot != 0.0) {
    float luma = dot(b, vec3(0.3, 0.59, 0.11));
    float mapped = log(max(luma, 0.0) + 1.0);
    b *= luma > 0.0 ? mapped / luma : 0.0;
  }
  b = pow(max(b, vec3(0.0)), vec3(1.0 / gamma));
  fragColor = vec4(clamp(b, 0.0, 1.0), 1.0);
}
`;
