// Lit Object (IBL). Port of IBLWidget for the equirect-HDRI path: an object
// (sphere default; OBJ loader is future work) shaded by the environment, over an
// environment background. Modes: "No IBL" (directional light) and "IBL"
// (cosine-weighted Monte-Carlo). Importance sampling (IBL IS/MIS) is future work.
// Left-drag orbits, right-drag zooms, double-click resets.
// "No IBL" lights the object with one directional light from the incident angle
// (store incidentTheta/Phi, z-up like the other views) instead of the HDRI.

import { BaseView, DEG2RAD_, RAD2DEG, bool, num, obj, round6, str, type ViewState } from './base-view.js';
import { BrdfProgramCache } from '../gl/brdf-program.js';
import { buildProgram, Uniforms } from '../gl/renderer.js';
import { loadTemplate } from '../brdf/shader-builder.js';
import { uploadEnv, type EnvTexture } from '../gl/env-texture.js';
import { buildSphere, parseObjMesh, type IndexedMesh } from '../gl/mesh.js';
import { perspective, lookAt, DEG2RAD } from '../gl/mat4.js';
import { boolControl, floatControl, selectControl } from '../ui/controls.js';
import { parseHdr } from '../io/hdr.js';
import type { HdrImage } from '../io/hdr.js';
import type { Store } from '../state/store.js';

const FOV_Y = 45.0;
export const MAX_ACCUM_FRAMES = 512;

interface RenderTarget {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  depth: WebGLRenderbuffer | null;
  width: number;
  height: number;
}

export class LitObjectView extends BaseView {
  protected override readonly supportsBackgroundOverride = true;
  private cache: BrdfProgramCache;
  private env: EnvTexture;
  private bg: { program: WebGLProgram; u: Uniforms } | null = null;
  private accum: { program: WebGLProgram; u: Uniforms };
  private display: { program: WebGLProgram; u: Uniforms };
  private posVBO: WebGLBuffer;
  private normalVBO: WebGLBuffer;
  private idxVBO: WebGLBuffer;
  private indexCount = 0;
  private emptyVAO: WebGLVertexArrayObject;
  private sceneTarget: RenderTarget | null = null;
  private accumTargets: [RenderTarget, RenderTarget] | null = null;
  private accumRead = 0;
  private accumFrame = 0;
  private floatRenderTargets = false;
  private resetUnsub: (() => void) | null = null;

  private lookTheta = 1.2;
  private lookPhi = 0.6;
  private lookZoom = 1.0;
  private renderWithIBL = true;
  private gamma = 2.2;
  private exposure = 0.0;
  private numSamples = 128;
  private meshName = 'sphere';
  private hideBackground = false;
  private grayscaleIBL = false;
  private envName = '';
  private envSelectButton: HTMLButtonElement | null = null;
  private envSelectText: HTMLElement | null = null;
  private envSelectPopover: HTMLElement | null = null;
  private envSelectPreviewImg: HTMLImageElement | null = null;
  private envSelectPreviewName: HTMLElement | null = null;
  /** Pending environment / mesh load, awaited before snapshots. */
  private pendingLoad: Promise<void> = Promise.resolve();

  private readonly closeEnvironmentMenuOnWindowChange = () => this.closeEnvironmentMenu();
  private readonly closeEnvironmentMenuOnOutsidePointer = (e: PointerEvent) => {
    if (!this.envSelectPopover || this.envSelectPopover.hidden) return;
    if (e.target instanceof Node && (this.envSelectPopover.contains(e.target) || this.envSelectButton?.contains(e.target))) {
      return;
    }
    this.closeEnvironmentMenu();
  };

  constructor(
    container: HTMLElement,
    store: Store,
    envImg: HdrImage,
    private envNames: string[] = [],
    private objNames: string[] = [],
    private envThumbs: Record<string, string> = {},
  ) {
    super('litObject', container, store, 'Lit Object');
    const gl = this.gl;
    this.envName = envNames[0] ?? '';

    this.floatRenderTargets = !!gl.getExtension('EXT_color_buffer_float');
    this.env = uploadEnv(gl, envImg);

    this.posVBO = gl.createBuffer()!;
    this.normalVBO = gl.createBuffer()!;
    this.idxVBO = gl.createBuffer()!;
    this.setMesh(buildSphere(1.0, 100, 100));
    this.emptyVAO = gl.createVertexArray()!;
    const accumProgram = buildProgram(gl, FULLSCREEN_VERT, ACCUM_FRAG, 'accumulate');
    const displayProgram = buildProgram(gl, FULLSCREEN_VERT, DISPLAY_FRAG, 'displayTexture');
    this.accum = {
      program: accumProgram,
      u: new Uniforms(gl, accumProgram),
    };
    this.display = {
      program: displayProgram,
      u: new Uniforms(gl, displayProgram),
    };

    this.buildControls();
    this.setupInteraction();
    // Restart accumulation only when a store change actually affects this
    // view's image. In IBL mode the incident-light direction (and N·L toggle)
    // is unused by the shader, so light drags neither reset the converged
    // result nor trigger a re-render of the Monte-Carlo scene pass.
    this.resetUnsub = store.subscribe(() => {
      const sig = this.storeSignature();
      if (sig === this.lastStoreSig) return;
      this.lastStoreSig = sig;
      this.resetAccumulation();
    });

    this.cache = new BrdfProgramCache(gl, 'iblObject.vert', 'iblObject.frag', 'IBL');
    const bgReady = Promise.all([loadTemplate('iblBackground.vert'), loadTemplate('iblBackground.frag')])
      .then(([v, f]) => {
        const program = buildProgram(gl, v, f, 'iblBackground');
        this.bg = { program, u: new Uniforms(gl, program) };
      });
    this.ready = Promise.all([this.cache.ready, bgReady]);
    this.ready.then(() => this.requestRender()).catch((e) => console.error('IBL templates', e));
  }

  override getViewState(): ViewState {
    return {
      env: this.envName,
      object: this.meshName,
      ibl: this.renderWithIBL,
      samples: this.numSamples,
      gamma: round6(this.gamma),
      exposure: round6(this.exposure),
      hideBackground: this.hideBackground,
      grayIBL: this.grayscaleIBL,
      camera: {
        theta: round6(this.lookTheta * RAD2DEG),
        phi: round6(this.lookPhi * RAD2DEG),
        zoom: round6(this.lookZoom),
      },
    };
  }

  override async applyViewState(s: ViewState): Promise<void> {
    const loads: Promise<void>[] = [];
    const env = str(s, 'env');
    if (env && env !== this.envName) {
      if (this.envNames.includes(env)) loads.push(this.loadEnvironment(env));
      else console.warn(`Unknown environment "${env}" (available: ${this.envNames.join(', ')})`);
    }
    const object = str(s, 'object');
    if (object && object !== this.meshName) {
      if (object === 'sphere' || this.objNames.includes(object)) loads.push(this.loadObject(object));
      else console.warn(`Unknown object "${object}" (available: sphere, ${this.objNames.join(', ')})`);
    }
    this.renderWithIBL = bool(s, 'ibl') ?? this.renderWithIBL;
    const samples = num(s, 'samples');
    if (samples !== undefined) this.numSamples = Math.max(1, Math.min(1024, Math.round(samples)));
    this.gamma = num(s, 'gamma') ?? this.gamma;
    this.exposure = num(s, 'exposure') ?? this.exposure;
    this.hideBackground = bool(s, 'hideBackground') ?? this.hideBackground;
    this.grayscaleIBL = bool(s, 'grayIBL') ?? this.grayscaleIBL;
    const cam = obj(s, 'camera');
    const theta = num(cam, 'theta');
    const phi = num(cam, 'phi');
    if (theta !== undefined) this.lookTheta = Math.max(0.05, Math.min(Math.PI - 0.05, theta * DEG2RAD_));
    if (phi !== undefined) this.lookPhi = phi * DEG2RAD_;
    this.lookZoom = Math.max(0.2, Math.min(5, num(cam, 'zoom') ?? this.lookZoom));
    await Promise.all(loads);
    this.closeEnvironmentMenu();
    this.footer.replaceChildren();
    this.buildControls();
    this.lastStoreSig = this.storeSignature();
    this.resetAccumulation();
  }

  /** Environment and object names this view can load. */
  available(): { environments: string[]; objects: string[] } {
    return { environments: [...this.envNames], objects: ['sphere', ...this.objNames] };
  }

  protected override async prepareSnapshot(): Promise<void> {
    await this.pendingLoad;
  }

  /**
   * IBL: restart accumulation and run exactly `frames` Monte-Carlo passes
   * (default: the converged count used on screen), so the image is repeatable.
   */
  protected override renderSnapshot(options: { frames?: number }): void {
    if (!this.renderWithIBL) {
      this.renderFrame();
      return;
    }
    const frames = Math.max(1, Math.min(MAX_ACCUM_FRAMES, Math.round(options.frames ?? MAX_ACCUM_FRAMES)));
    this.accumFrame = 0;
    this.accumRead = 0;
    this.renderFrame(); // also (re)allocates the targets at the fixed size
    this.accumFrame = 0;
    this.accumRead = 0;
    for (let i = 0; i < frames; i++) this.renderFrame();
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
    if (w === 0 || h === 0 || !this.bg) return;

    this.ensureTargets(w, h);
    const cam = this.camera();
    if (!this.sceneTarget || !this.accumTargets) {
      return;
    }

    if (!this.renderWithIBL) {
      this.drawScene(cam, this.sceneTarget.framebuffer, w, h);
      this.drawTextureToScreen(this.sceneTarget.texture, w, h);
      this.updateAccumStatus(0);
      return;
    }

    // Converged: re-present the accumulated image (applies current
    // gamma/exposure) without paying for another Monte-Carlo scene pass.
    if (this.accumFrame >= MAX_ACCUM_FRAMES) {
      this.drawTextureToScreen(this.accumTargets[this.accumRead].texture, w, h);
      this.updateAccumStatus(this.accumFrame);
      return;
    }

    this.drawScene(cam, this.sceneTarget.framebuffer, w, h);

    const write = this.accumRead === 0 ? 1 : 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumTargets[write].framebuffer);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.useProgram(this.accum.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.accumTargets[this.accumRead].texture);
    this.accum.u.i('previousTex', 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTarget.texture);
    this.accum.u.i('currentTex', 1);
    this.accum.u.i('frameIndex', this.accumFrame);
    gl.bindVertexArray(this.emptyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.depthMask(true);

    this.accumRead = write;
    this.accumFrame = Math.min(this.accumFrame + 1, MAX_ACCUM_FRAMES);
    this.drawTextureToScreen(this.accumTargets[this.accumRead].texture, w, h);
    this.updateAccumStatus(this.accumFrame);
    if (this.accumFrame < MAX_ACCUM_FRAMES) this.requestRender();
  }

  private drawScene(cam: ReturnType<LitObjectView['camera']>, framebuffer: WebGLFramebuffer | null, w: number, h: number): void {
    const gl = this.gl;
    if (!this.bg) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, this.snapshotClearAlpha ? 0 : 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    // background (env), behind everything; skipped (alpha 0) for a snapshot
    // with a transparent / solid background
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    if (!this.snapshotClearAlpha) {
      gl.useProgram(this.bg.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.env.texture);
      this.bg.u.i('envMap', 0);
      this.bg.u.v3('camForward', ...cam.camForward);
      this.bg.u.v3('camRight', ...cam.camRight);
      this.bg.u.v3('camUp', ...cam.camUp);
      this.bg.u.f('envIntensity', 1.0);
      this.bg.u.f('hideBackground', this.hideBackground ? 1 : 0);
      this.bg.u.f('grayscaleIBL', this.grayscaleIBL ? 1 : 0);
      gl.bindVertexArray(this.emptyVAO);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    }

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
    prog.u.f('useNDotL', s.useNDotL ? 1 : 0);
    prog.u.f('renderWithIBL', this.renderWithIBL ? 1 : 0);
    prog.u.f('envIntensity', 1.0);
    prog.u.f('grayscaleIBL', this.grayscaleIBL ? 1 : 0);
    prog.u.i('numSamples', this.numSamples);
    prog.u.i('frameIndex', this.accumFrame);
    // env on unit 1 (unit 0 may be used by measured BRDF data)
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.env.texture);
    prog.u.i('envMap', 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.env.conditionalCdf);
    prog.u.i('envConditionalCdf', 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.env.marginalCdf);
    prog.u.i('envMarginalCdf', 3);
    prog.u.f('envTotalWeight', this.env.totalWeight);
    this.cache.applyParams(prog.u, pkg.instance);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posVBO);
    gl.enableVertexAttribArray(prog.posLoc);
    gl.vertexAttribPointer(prog.posLoc, 3, gl.FLOAT, false, 0, 0);
    const normalLoc = gl.getAttribLocation(prog.program, 'vtx_normal');
    if (normalLoc >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.normalVBO);
      gl.enableVertexAttribArray(normalLoc);
      gl.vertexAttribPointer(normalLoc, 3, gl.FLOAT, false, 0, 0);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxVBO);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
  }

  private ensureTargets(w: number, h: number): void {
    const sameSize = this.sceneTarget?.width === w && this.sceneTarget.height === h;
    if (sameSize && this.accumTargets?.[0].width === w && this.accumTargets[0].height === h) return;

    this.disposeTarget(this.sceneTarget);
    if (this.accumTargets) {
      this.disposeTarget(this.accumTargets[0]);
      this.disposeTarget(this.accumTargets[1]);
    }
    this.sceneTarget = createRenderTarget(this.gl, w, h, this.floatRenderTargets, true);
    this.accumTargets = [
      createRenderTarget(this.gl, w, h, this.floatRenderTargets, false),
      createRenderTarget(this.gl, w, h, this.floatRenderTargets, false),
    ];
    this.resetAccumulation();
  }

  private drawTextureToScreen(texture: WebGLTexture, w: number, h: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.useProgram(this.display.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    this.display.u.i('sourceTex', 0);
    this.display.u.f('gamma', this.gamma);
    this.display.u.f('exposure', this.exposure);
    gl.bindVertexArray(this.emptyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.depthMask(true);
  }

  private lastStoreSig: string | null = null;

  /** Serialize the store-derived inputs this view's image depends on. */
  private storeSignature(): string {
    const pkg = this.store.topmostEnabled();
    const s = this.store.state;
    return JSON.stringify([
      pkg ? [pkg.instance.id, [...pkg.instance.values]] : null,
      this.renderWithIBL ? null : [s.incidentTheta, s.incidentPhi, s.useNDotL],
    ]);
  }

  private resetAccumulation(): void {
    this.accumFrame = 0;
    this.accumRead = 0;
    this.requestRender();
  }

  private updateAccumStatus(frames: number): void {
    void frames;
  }

  private disposeTarget(target: RenderTarget | null): void {
    if (!target) return;
    const gl = this.gl;
    gl.deleteFramebuffer(target.framebuffer);
    gl.deleteTexture(target.texture);
    if (target.depth) gl.deleteRenderbuffer(target.depth);
  }

  override dispose(): void {
    super.dispose();
    this.closeEnvironmentMenu();
    this.resetUnsub?.();
  }

  private setMesh(mesh: IndexedMesh): void {
    const gl = this.gl;
    this.indexCount = mesh.indices.length;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posVBO);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.normalVBO);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.normals ?? mesh.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxVBO);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  }

  private loadEnvironment(name: string): Promise<void> {
    const p = this.loadEnvironmentNow(name);
    this.pendingLoad = this.pendingLoad.then(() => p);
    return p;
  }

  private async loadEnvironmentNow(name: string): Promise<void> {
    if (!name) return;
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}environments/${name}`);
      if (!res.ok) throw new Error(`${res.status}`);
      this.env = uploadEnv(this.gl, parseHdr(await res.arrayBuffer()));
      this.envName = name;
      this.updateEnvironmentSelectButton();
      this.resetAccumulation();
    } catch (e) {
      console.error(`Failed to load environment ${name}`, e);
    }
  }

  private loadObject(name: string): Promise<void> {
    const p = this.loadObjectNow(name);
    this.pendingLoad = this.pendingLoad.then(() => p);
    return p;
  }

  private async loadObjectNow(name: string): Promise<void> {
    if (name === 'sphere') {
      this.meshName = name;
      this.setMesh(buildSphere(1.0, 100, 100));
      this.resetAccumulation();
      return;
    }
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}obj/${name}`);
      if (!res.ok) throw new Error(`${res.status}`);
      this.meshName = name;
      this.setMesh(parseObjMesh(await res.text()));
      this.resetAccumulation();
    } catch (e) {
      console.error(`Failed to load object ${name}`, e);
    }
  }

  private buildControls(): void {
    const iblChecks = document.createElement('div');
    iblChecks.className = 'compact-checks lit-object-checks';
    iblChecks.append(
      boolControl(
        'IBL',
        this.renderWithIBL,
        (v) => {
          this.renderWithIBL = v;
          this.lastStoreSig = this.storeSignature();
          this.resetAccumulation();
        },
        'On: HDRI image-based lighting. Off: one directional light from the incident θ/φ (No IBL).',
      ),
      boolControl('Hide BG IBL', this.hideBackground, (v) => {
        this.hideBackground = v;
        this.resetAccumulation();
      }),
      boolControl('Gray IBL', this.grayscaleIBL, (v) => {
        this.grayscaleIBL = v;
        this.resetAccumulation();
      }),
    );

    this.footer.append(
      this.buildEnvironmentSelect(),
      selectControl(
        'Object',
        [
          { value: 'sphere', text: 'sphere' },
          ...this.objNames.map((name) => ({ value: name, text: name.replace(/\.obj$/i, '') })),
        ],
        this.meshName,
        (v) => void this.loadObject(v),
      ),
      iblChecks,
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

  private buildEnvironmentSelect(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'ctl-row env-select-row';
    const label = document.createElement('span');
    label.className = 'ctl-label';
    label.textContent = 'Env';
    label.title = 'Env';

    const wrap = document.createElement('div');
    wrap.className = 'env-select';
    this.envSelectButton = document.createElement('button');
    this.envSelectButton.type = 'button';
    this.envSelectButton.className = 'env-select-button';
    this.envSelectButton.setAttribute('aria-haspopup', 'listbox');
    this.envSelectButton.setAttribute('aria-expanded', 'false');
    this.envSelectText = document.createElement('span');
    this.envSelectText.className = 'env-select-button-text';
    const arrow = document.createElement('span');
    arrow.className = 'env-select-arrow';
    arrow.textContent = 'v';
    this.envSelectButton.append(this.envSelectText, arrow);
    this.envSelectButton.addEventListener('click', () => {
      if (this.envSelectPopover?.isConnected && !this.envSelectPopover.hidden) this.closeEnvironmentMenu();
      else this.openEnvironmentMenu();
    });
    this.envSelectButton.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.openEnvironmentMenu(true);
      }
    });

    this.envSelectPopover = document.createElement('div');
    this.envSelectPopover.className = 'env-select-popover';
    this.envSelectPopover.hidden = true;
    const list = document.createElement('div');
    list.className = 'env-select-list';
    list.setAttribute('role', 'listbox');
    for (const name of this.envNames) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'env-select-option';
      option.dataset.envName = name;
      option.setAttribute('role', 'option');
      option.textContent = this.environmentLabel(name);
      option.title = this.environmentLabel(name);
      option.addEventListener('mouseenter', () => this.setEnvironmentMenuPreview(name));
      option.addEventListener('focus', () => this.setEnvironmentMenuPreview(name));
      option.addEventListener('click', () => {
        this.closeEnvironmentMenu();
        void this.loadEnvironment(name);
      });
      option.addEventListener('keydown', (e) => this.handleEnvironmentOptionKey(e, option));
      list.append(option);
    }

    const preview = document.createElement('div');
    preview.className = 'env-select-preview';
    this.envSelectPreviewImg = document.createElement('img');
    this.envSelectPreviewImg.alt = '';
    this.envSelectPreviewImg.loading = 'lazy';
    this.envSelectPreviewImg.decoding = 'async';
    this.envSelectPreviewName = document.createElement('span');
    this.envSelectPreviewName.className = 'env-select-preview-name';
    preview.append(this.envSelectPreviewImg, this.envSelectPreviewName);
    this.envSelectPopover.append(list, preview);

    wrap.append(this.envSelectButton);
    row.append(label, wrap);
    this.updateEnvironmentSelectButton();
    return row;
  }

  private openEnvironmentMenu(focusSelected = false): void {
    if (!this.envSelectPopover || !this.envSelectButton) return;
    document.body.append(this.envSelectPopover);
    this.envSelectPopover.hidden = false;
    this.envSelectButton.setAttribute('aria-expanded', 'true');
    this.positionEnvironmentMenu();
    this.syncEnvironmentOptionSelection();
    this.setEnvironmentMenuPreview(this.envName);
    document.addEventListener('pointerdown', this.closeEnvironmentMenuOnOutsidePointer);
    window.addEventListener('resize', this.closeEnvironmentMenuOnWindowChange);
    const selected = this.environmentOption(this.envName);
    selected?.scrollIntoView({ block: 'nearest' });
    if (focusSelected) selected?.focus();
  }

  private closeEnvironmentMenu(): void {
    if (!this.envSelectPopover) return;
    this.envSelectPopover.hidden = true;
    this.envSelectPopover.remove();
    this.envSelectButton?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', this.closeEnvironmentMenuOnOutsidePointer);
    window.removeEventListener('resize', this.closeEnvironmentMenuOnWindowChange);
  }

  private positionEnvironmentMenu(): void {
    if (!this.envSelectButton || !this.envSelectPopover) return;
    const rect = this.envSelectButton.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    const width = Math.min(window.innerWidth - margin * 2, Math.max(520, rect.width + 240));
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
    const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
    const spaceAbove = rect.top - gap - margin;
    const openAbove = spaceBelow < 240 && spaceAbove > spaceBelow;
    const availableHeight = openAbove ? spaceAbove : spaceBelow;
    const maxHeight = Math.max(160, Math.min(390, availableHeight));
    const top = openAbove ? Math.max(margin, rect.top - gap - maxHeight) : rect.bottom + gap;
    this.envSelectPopover.style.left = `${left}px`;
    this.envSelectPopover.style.top = `${top}px`;
    this.envSelectPopover.style.width = `${width}px`;
    this.envSelectPopover.style.maxHeight = `${maxHeight}px`;
    this.envSelectPopover.style.setProperty('--env-select-max-height', `${maxHeight}px`);
    this.envSelectPopover.dataset.placement = openAbove ? 'top' : 'bottom';
  }

  private updateEnvironmentSelectButton(): void {
    if (this.envSelectText) {
      const text = this.environmentLabel(this.envName);
      this.envSelectText.textContent = text;
      this.envSelectText.title = text;
    }
    this.syncEnvironmentOptionSelection();
    this.setEnvironmentMenuPreview(this.envName);
  }

  private syncEnvironmentOptionSelection(): void {
    if (!this.envSelectPopover) return;
    for (const option of this.envSelectPopover.querySelectorAll<HTMLElement>('.env-select-option')) {
      option.setAttribute('aria-selected', String(option.dataset.envName === this.envName));
    }
  }

  private setEnvironmentMenuPreview(name: string): void {
    if (!this.envSelectPreviewImg || !this.envSelectPreviewName) return;
    const thumb = this.envThumbs[name];
    this.envSelectPreviewImg.hidden = !thumb;
    if (thumb) this.envSelectPreviewImg.src = `${import.meta.env.BASE_URL}environment-thumbs/${thumb}`;
    const text = this.environmentLabel(name);
    this.envSelectPreviewName.textContent = text;
    this.envSelectPreviewName.title = text;
  }

  private handleEnvironmentOptionKey(e: KeyboardEvent, option: HTMLButtonElement): void {
    if (!this.envSelectPopover) return;
    const options = [...this.envSelectPopover.querySelectorAll<HTMLButtonElement>('.env-select-option')];
    const index = options.indexOf(option);
    if (e.key === 'Escape') {
      e.preventDefault();
      this.closeEnvironmentMenu();
      this.envSelectButton?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? Math.min(options.length - 1, index + 1) : Math.max(0, index - 1);
      options[next]?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const name = option.dataset.envName;
      if (!name) return;
      this.closeEnvironmentMenu();
      void this.loadEnvironment(name);
    }
  }

  private environmentOption(name: string): HTMLButtonElement | null {
    if (!this.envSelectPopover) return null;
    return (
      [...this.envSelectPopover.querySelectorAll<HTMLButtonElement>('.env-select-option')].find(
        (option) => option.dataset.envName === name,
      ) ?? null
    );
  }

  private environmentLabel(name: string): string {
    return name.replace(/\.(hdr|exr)$/i, '');
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
      this.resetAccumulation();
    });
    c.addEventListener('dblclick', () => {
      this.lookTheta = 1.2;
      this.lookPhi = 0.6;
      this.lookZoom = 1.0;
      this.resetAccumulation();
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

function createRenderTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  useFloat: boolean,
  withDepth: boolean,
): RenderTarget {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) throw new Error('failed to create accumulation target');

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    useFloat ? gl.RGBA16F : gl.RGBA8,
    width,
    height,
    0,
    gl.RGBA,
    useFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
    null,
  );

  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  let depth: WebGLRenderbuffer | null = null;
  if (withDepth) {
    depth = gl.createRenderbuffer();
    if (!depth) throw new Error('failed to create depth buffer');
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  }
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteTexture(texture);
    gl.deleteFramebuffer(framebuffer);
    if (depth) gl.deleteRenderbuffer(depth);
    throw new Error(`accumulation framebuffer incomplete: ${status}`);
  }

  return { framebuffer, texture, depth, width, height };
}

const FULLSCREEN_VERT = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const ACCUM_FRAG = `#version 300 es
precision highp float;
uniform sampler2D previousTex;
uniform sampler2D currentTex;
uniform int frameIndex;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec4 current = texture(currentTex, vUv);
  if (frameIndex == 0) {
    fragColor = current;
  } else {
    vec4 previous = texture(previousTex, vUv);
    float n = float(frameIndex);
    fragColor = (previous * n + current) / (n + 1.0);
  }
}
`;

const DISPLAY_FRAG = `#version 300 es
precision highp float;
uniform sampler2D sourceTex;
uniform float gamma;
uniform float exposure;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec4 src = texture(sourceTex, vUv);
  vec3 c = max(src.rgb, vec3(0.0));
  c *= pow(2.0, exposure);
  c = pow(c, vec3(1.0 / gamma));
  // alpha is 1 except in snapshots with a transparent / solid background
  fragColor = vec4(clamp(c, 0.0, 1.0), clamp(src.a, 0.0, 1.0));
}
`;
