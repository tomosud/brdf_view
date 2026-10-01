// Lit Object (IBL). Port of IBLWidget for the equirect-HDRI path: an object
// (sphere default; OBJ loader is future work) shaded by the environment, over an
// environment background. Modes: "No IBL" (directional light) and "IBL"
// (cosine-weighted Monte-Carlo). Importance sampling (IBL IS/MIS) is future work.
// Left-drag orbits, right-drag zooms, double-click resets.
// "No IBL" lights the object with one directional light from the incident angle
// (store incidentTheta/Phi, z-up like the other views) instead of the HDRI.

import { BaseView, DEG2RAD_, RAD2DEG, bool, num, obj, round6, str, type ViewState } from './base-view.js';
import { BrdfProgramCache, BVH_NODE_UNIT, BVH_TRI_UNIT, NORMAL_MAP_UNIT } from '../gl/brdf-program.js';
import { textureBindings } from '../brdf/param-texture.js';
import { buildProgram, Uniforms } from '../gl/renderer.js';
import { loadTemplate } from '../brdf/shader-builder.js';
import { uploadEnv, type EnvTexture } from '../gl/env-texture.js';
import { buildSphere, computeTangents, parseObjMesh, type IndexedMesh } from '../gl/mesh.js';
import { bakeOcclusionSH, OCCLUSION_SH_COEFFS } from '../gl/visibility-bake.js';
import { BVH_TEXTURE_WIDTH, buildBvhAsync, type PackedBvh } from '../gl/bvh.js';
import { perspective, lookAt, DEG2RAD } from '../gl/mat4.js';
import { TONEMAP_GLSL, ToneMapper } from '../gl/tonemap.js';
import { SssPipeline, sssDefines, sssParamsOf, sssSupport } from '../gl/sss.js';
import { boolControl, floatControl, selectControl } from '../ui/controls.js';
import { parseHdr } from '../io/hdr.js';
import type { HdrImage } from '../io/hdr.js';
import type { Store } from '../state/store.js';

const FOV_Y = 45.0;
/** Converged accumulation, in passes of `samples` Monte-Carlo samples per pixel. */
export const MAX_ACCUM_FRAMES = 512;
/**
 * Ray mode traces a shadow ray per sample, so one frame takes at most
 * RAY_SAMPLES_PER_FRAME samples per pixel at RAY_PIXEL_BUDGET pixels (fewer for
 * larger targets) and a pass is split into several frames. This keeps each draw
 * well under the GPU watchdog (Windows TDR, about 2 s); the converged sample
 * count is unchanged.
 */
const RAY_SAMPLES_PER_FRAME = 16;
const RAY_PIXEL_BUDGET = 512 * 512;
/** Ray mode on screen: most accumulation frames drawn per displayed frame. */
const RAY_MAX_STEPS_PER_DRAW = 16;
/** Shadow-ray origin offset, relative to the mesh radius. */
const RAY_EPSILON = 1e-4;
/**
 * On-screen early stop of the accumulation (see LitObjectView.checkAutoStop):
 * first reading at this many passes, then at every doubling.
 */
const AUTO_STOP_FIRST_PASS = 8;
/** The displayed image is sampled on a grid of this many pixels per side. */
const AUTO_STOP_PROBE_SIZE = 128;
/**
 * Samples (of PROBE_SIZE^2) that may still move by 2/255 or more between two
 * readings: 1 %. Measured on the head model with ray-traced occlusion: 1.7 % at
 * 16 passes, 0.6 % at 33, 0.24 % at 67 (the rest moves by 1/255 or not at all).
 */
const AUTO_STOP_MAX_MOVED = Math.round(AUTO_STOP_PROBE_SIZE * AUTO_STOP_PROBE_SIZE * 0.01);
/** No sample may move by this much (in 1/255) between two readings. */
const AUTO_STOP_LARGE_STEP = 6;
/** Every mesh is scaled so that its largest dimension spans this many scene units. */
const MESH_EXTENT = 2;
/** Pseudo SSS: real size (cm) of the largest dimension when the mesh does not state one. */
const DEFAULT_SIZE_CM = 20;
const MIN_SIZE_CM = 0.1;
const MAX_SIZE_CM = 1000;

/** Lit Object self-occlusion: none, baked SH, or ray traced against a BVH. */
export type OcclusionMode = 'off' | 'sh' | 'ray';
const OCCLUSION_MODES: readonly OcclusionMode[] = ['off', 'sh', 'ray'];

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
  private toneMapper = new ToneMapper(this.gl);
  protected override readonly supportsHdr = true;
  private env: EnvTexture;
  private bg: { program: WebGLProgram; u: Uniforms } | null = null;
  private accum: { program: WebGLProgram; u: Uniforms };
  private display: { program: WebGLProgram; u: Uniforms };
  private posVBO: WebGLBuffer;
  private normalVBO: WebGLBuffer;
  private uvVBO: WebGLBuffer;
  private tangentVBO: WebGLBuffer;
  private occlusionVBO: WebGLBuffer;
  /** Whether occlusionVBO holds a bake for the current mesh. */
  private meshHasOcclusion = false;
  private meshHasUVs = false;
  /** Current mesh, kept for building the BVH on demand. */
  private meshData: IndexedMesh | null = null;
  private meshRadius = 1;
  /** Bumped by setMesh so a BVH finished for an older mesh is dropped. */
  private meshGeneration = 0;
  private bvhTextures: { nodes: WebGLTexture; tris: WebGLTexture } | null = null;
  private bvhBuild: Promise<void> | null = null;
  /** Camera drag in progress: Ray mode previews with SH until the drag ends. */
  private interacting = false;
  /** Ray mode: accumulation frames per displayed frame, adapted to the frame interval. */
  private rayStepsPerDraw = 1;
  private lastAccumDrawTime = 0;
  private inSnapshot = false;
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
  private occlusion: OcclusionMode = 'sh';
  /**
   * Pseudo SSS (src/gl/sss.ts): blur the diffuse light in screen space. Only
   * drawn for a .brdf that declares the hook functions; otherwise ignored.
   */
  private sssEnabled = false;
  /** Real size (cm) of the mesh's largest dimension: converts the SSS radius (cm) to scene units. */
  private sizeCm = DEFAULT_SIZE_CM;
  /** Size the current mesh suggests (its own unit, or DEFAULT_SIZE_CM). */
  private meshSizeCm = DEFAULT_SIZE_CM;
  private sss: SssPipeline | null = null;
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
    this.uvVBO = gl.createBuffer()!;
    this.tangentVBO = gl.createBuffer()!;
    this.occlusionVBO = gl.createBuffer()!;
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
      this.syncSssControls();
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
      occlusion: this.occlusion,
      sss: this.sssEnabled,
      sizeCm: round6(this.sizeCm),
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
    this.occlusion = parseOcclusion(s.occlusion) ?? this.occlusion;
    this.sssEnabled = bool(s, 'sss') ?? this.sssEnabled;
    const cam = obj(s, 'camera');
    const theta = num(cam, 'theta');
    const phi = num(cam, 'phi');
    if (theta !== undefined) this.lookTheta = Math.max(0.05, Math.min(Math.PI - 0.05, theta * DEG2RAD_));
    if (phi !== undefined) this.lookPhi = phi * DEG2RAD_;
    this.lookZoom = Math.max(0.2, Math.min(5, num(cam, 'zoom') ?? this.lookZoom));
    await Promise.all(loads);
    // after the object load: loading a mesh resets the size to that mesh's own
    const sizeCm = num(s, 'sizeCm');
    if (sizeCm !== undefined) this.sizeCm = clampSize(sizeCm);
    if (this.occlusion === 'ray') void this.ensureBvh();
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
    if (this.occlusion === 'ray') await this.ensureBvh();
  }

  /**
   * IBL: restart accumulation and run exactly `frames` Monte-Carlo passes
   * (default: the converged count used on screen), so the image is repeatable.
   * In Ray mode each pass is drawn as several smaller frames (same samples).
   */
  protected override renderSnapshot(options: { frames?: number }): void {
    if (!this.renderWithIBL) {
      this.renderFrame();
      return;
    }
    this.interacting = false;
    const passes = Math.max(1, Math.min(MAX_ACCUM_FRAMES, Math.round(options.frames ?? MAX_ACCUM_FRAMES)));
    this.accumFrame = 0;
    this.accumRead = 0;
    this.renderFrame(); // also (re)allocates the targets at the fixed size
    this.accumFrame = 0;
    this.accumRead = 0;
    const frames = passes * this.framesPerPass();
    this.inSnapshot = true;
    try {
      for (let i = 0; i < frames; i++) {
        this.renderFrame();
        // submit as we go rather than queueing thousands of ray-traced draws
        if (i % 16 === 15) this.gl.flush();
      }
    } finally {
      this.inSnapshot = false;
    }
  }

  /** Occlusion actually drawn this frame: 0 off, 1 SH, 2 ray (shader's occlusionMode). */
  private effectiveOcclusion(): 0 | 1 | 2 {
    // Ray falls back to SH while the BVH is being built and while the camera moves.
    if (this.occlusion === 'ray' && this.bvhTextures && !this.interacting) return 2;
    if (this.occlusion !== 'off' && this.meshHasOcclusion) return 1;
    return 0;
  }

  /** Monte-Carlo samples per pixel drawn in one frame. */
  private samplesPerFrame(): number {
    if (this.effectiveOcclusion() !== 2) return this.numSamples;
    const pixels = Math.max(1, this.canvas.width * this.canvas.height);
    const budget = Math.floor((RAY_SAMPLES_PER_FRAME * RAY_PIXEL_BUDGET) / pixels);
    return Math.max(1, Math.min(this.numSamples, RAY_SAMPLES_PER_FRAME, budget));
  }

  /** Frames that make up one pass of `numSamples` samples. */
  private framesPerPass(): number {
    return Math.ceil(this.numSamples / this.samplesPerFrame());
  }

  private maxAccumFrames(): number {
    return MAX_ACCUM_FRAMES * this.framesPerPass();
  }

  /**
   * Accumulation frames to draw before presenting. Ray frames are small, so on
   * screen several are drawn per animation frame while the frame interval stays
   * short (the browser slows animation frames down when the GPU falls behind).
   */
  private accumStepsThisDraw(): number {
    if (this.inSnapshot || this.effectiveOcclusion() !== 2) {
      this.lastAccumDrawTime = 0;
      return 1;
    }
    const now = performance.now();
    if (this.lastAccumDrawTime > 0 && this.accumFrame > 0) {
      const interval = now - this.lastAccumDrawTime;
      if (interval < 25) this.rayStepsPerDraw = Math.min(RAY_MAX_STEPS_PER_DRAW, this.rayStepsPerDraw + 1);
      else if (interval > 50) this.rayStepsPerDraw = Math.max(1, this.rayStepsPerDraw >> 1);
    }
    this.lastAccumDrawTime = now;
    return this.rayStepsPerDraw;
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

  /** Whether the pseudo SSS can be drawn at all for the BRDF on display (drives the checkbox). */
  private sssAvailable(): boolean {
    const pkg = this.store.topmostEnabled();
    return this.floatRenderTargets && !!pkg && sssSupport(pkg.instance.def).diffuse;
  }

  /**
   * The pseudo-SSS pipeline for this frame, or null for the regular path.
   * Switching between the two restarts the accumulation (separate targets).
   */
  private activeSss(w: number, h: number): SssPipeline | null {
    const active = this.sssEnabled && this.sssAvailable();
    if (active !== this.sssWasActive) {
      this.sssWasActive = active;
      this.accumFrame = 0;
      this.accumRead = 0;
    }
    if (!active) return null;
    this.sss ??= new SssPipeline(this.gl);
    if (this.sss.ensure(w, h)) this.accumFrame = 0;
    return this.sss;
  }
  private sssWasActive = false;

  /** Blur the diffuse and recombine; returns the texture to present. */
  private resolveSss(sss: SssPipeline, source: 'scene' | 'accum', cam: ReturnType<LitObjectView['camera']>, h: number, converged: boolean): WebGLTexture {
    const pkg = this.store.topmostEnabled()!;
    return sss.resolve(source, {
      params: sssParamsOf(pkg.instance),
      cmPerUnit: this.sizeCm / MESH_EXTENT,
      pixelsPerUnitAtDepth1: 0.5 * h * cam.proj[5],
      subSteps: converged || this.inSnapshot ? 8 : 4,
    });
  }

  protected draw(): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w === 0 || h === 0 || !this.bg) return;

    this.ensureTargets(w, h);
    const cam = this.camera();
    if (!this.sceneTarget || !this.accumTargets) {
      return;
    }
    const sss = this.activeSss(w, h);

    if (!this.renderWithIBL) {
      if (sss) {
        this.drawScene(cam, null, w, h, sss);
        this.drawTextureToScreen(this.resolveSss(sss, 'scene', cam, h, true), w, h);
      } else {
        this.drawScene(cam, this.sceneTarget.framebuffer, w, h);
        this.drawTextureToScreen(this.sceneTarget.texture, w, h);
      }
      this.updateAccumStatus(0);
      return;
    }

    /** The image to show: the running average, through the pseudo SSS when it is on. */
    const resolved = (converged: boolean) =>
      sss ? this.resolveSss(sss, 'accum', cam, h, converged) : this.accumTargets![this.accumRead].texture;

    // Converged: re-present the accumulated image (applies current
    // gamma/exposure) without paying for another Monte-Carlo scene pass.
    const maxFrames = this.maxAccumFrames();
    this.syncAutoStop();
    if (this.accumFrame >= maxFrames || this.autoStop.stopped) {
      this.drawTextureToScreen(resolved(true), w, h);
      this.autoStop.lastFrame = this.accumFrame;
      this.updateAccumStatus(this.accumFrame);
      return;
    }

    const steps = this.accumStepsThisDraw();
    for (let i = 0; i < steps && this.accumFrame < maxFrames; i++) this.accumulateFrame(cam, w, h, maxFrames, sss);
    let done = this.accumFrame >= maxFrames;
    let texture = resolved(done);
    if (!done && this.checkAutoStop(texture)) {
      done = true;
      texture = resolved(true);
    }
    this.drawTextureToScreen(texture, w, h);
    this.autoStop.lastFrame = this.accumFrame;
    this.updateAccumStatus(this.accumFrame);
    if (!done) this.requestRender();
  }

  /**
   * On-screen accumulation stops early once the displayed image no longer
   * changes: at pass counts 8, 16, 32, ... a coarse grid of the displayed
   * (exposed, tone-mapped, 8-bit) image is read back and compared with the
   * previous reading. When (almost) no sample moved by 2/255 or more while the
   * sample count doubled, further passes would not be visible, so the view
   * stops drawing and the GPU goes idle. Snapshots (render / capture) are not
   * affected: they always run the requested number of passes.
   */
  private autoStop = {
    stopped: false,
    /** accumFrame at the end of the previous draw; a smaller value now means the accumulation restarted. */
    lastFrame: 0,
    nextPass: AUTO_STOP_FIRST_PASS,
    previous: null as Uint8Array | null,
    /** Display settings the readings were taken with. */
    display: '',
  };
  private autoStopProbe: RenderTarget | null = null;

  private displaySignature(): string {
    return `${this.gamma}|${this.exposure}|${this.displayMode()}`;
  }

  /** Forget the readings when the accumulation restarted; resume when the display settings changed. */
  private syncAutoStop(): void {
    const a = this.autoStop;
    if (this.accumFrame < a.lastFrame) {
      a.stopped = false;
      a.previous = null;
      a.nextPass = AUTO_STOP_FIRST_PASS;
    } else if (a.display !== this.displaySignature() && (a.stopped || a.previous)) {
      // e.g. a higher exposure can make remaining noise visible again: take new readings from here on
      a.stopped = false;
      a.previous = null;
      a.nextPass = Math.max(AUTO_STOP_FIRST_PASS, Math.floor(this.accumFrame / this.framesPerPass()));
    }
    a.display = this.displaySignature();
  }

  /** At a checkpoint, compare the displayed image with the previous checkpoint; true = stop accumulating. */
  private checkAutoStop(texture: WebGLTexture): boolean {
    const a = this.autoStop;
    if (this.inSnapshot || this.interacting) return false;
    const passes = Math.floor(this.accumFrame / this.framesPerPass());
    if (passes < a.nextPass) return false;
    a.nextPass = passes * 2;

    const gl = this.gl;
    this.autoStopProbe ??= createRenderTarget(gl, AUTO_STOP_PROBE_SIZE, AUTO_STOP_PROBE_SIZE, 'byte', false);
    this.drawDisplay(texture, this.autoStopProbe.framebuffer, AUTO_STOP_PROBE_SIZE, AUTO_STOP_PROBE_SIZE);
    const now = new Uint8Array(AUTO_STOP_PROBE_SIZE * AUTO_STOP_PROBE_SIZE * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.autoStopProbe.framebuffer);
    gl.readPixels(0, 0, AUTO_STOP_PROBE_SIZE, AUTO_STOP_PROBE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, now);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const before = a.previous;
    a.previous = now;
    if (!before) return false;
    let moved = 0;
    for (let i = 0; i < now.length; i += 4) {
      const d = Math.max(Math.abs(now[i] - before[i]), Math.abs(now[i + 1] - before[i + 1]), Math.abs(now[i + 2] - before[i + 2]));
      if (d >= AUTO_STOP_LARGE_STEP) return false;
      if (d >= 2) moved++;
    }
    if (moved > AUTO_STOP_MAX_MOVED) return false;
    a.stopped = true;
    return true;
  }

  /** Draw one Monte-Carlo frame and fold it into the running average. */
  private accumulateFrame(
    cam: ReturnType<LitObjectView['camera']>,
    w: number,
    h: number,
    maxFrames: number,
    sss: SssPipeline | null = null,
  ): void {
    const gl = this.gl;
    if (!this.sceneTarget || !this.accumTargets) return;
    if (sss) {
      // pseudo SSS: same running average, over the pipeline's three targets
      this.drawScene(cam, null, w, h, sss);
      sss.accumulate(this.accumFrame);
      this.accumFrame = Math.min(this.accumFrame + 1, maxFrames);
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
    this.accumFrame = Math.min(this.accumFrame + 1, maxFrames);
  }

  /**
   * Draw background and object into `framebuffer`, or (pseudo SSS) into the
   * three targets of `sss`: the background then goes to the specular target only
   * and the object uses the BRDF_SSS shader variant.
   */
  private drawScene(
    cam: ReturnType<LitObjectView['camera']>,
    framebuffer: WebGLFramebuffer | null,
    w: number,
    h: number,
    sss: SssPipeline | null = null,
  ): void {
    const gl = this.gl;
    if (!this.bg) return;
    if (sss) {
      sss.beginScene(this.snapshotClearAlpha ? 0 : 1);
      sss.selectSceneOutputs(true);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, this.snapshotClearAlpha ? 0 : 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }
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
    sss?.selectSceneOutputs(false);
    const pkg = this.store.topmostEnabled();
    if (!pkg) return;
    const textured = textureBindings(pkg.instance);
    const normalMap = pkg.instance.normalMap;
    if ((textured.length || normalMap) && !this.meshHasUVs) this.warnNoUVs();
    const prog = this.cache.get(pkg.instance.def, textured, sss ? sssDefines(pkg.instance.def) : '');
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
    if (sss) prog.u.v3('sssCamForward', ...cam.camForward);
    prog.u.v3('incidentVector', iv[0], iv[1], iv[2]);
    prog.u.f('useNDotL', s.useNDotL ? 1 : 0);
    prog.u.f('renderWithIBL', this.renderWithIBL ? 1 : 0);
    prog.u.f('envIntensity', 1.0);
    prog.u.f('grayscaleIBL', this.grayscaleIBL ? 1 : 0);
    const occlusionMode = this.renderWithIBL ? this.effectiveOcclusion() : 0;
    prog.u.i('occlusionMode', occlusionMode);
    prog.u.f('rayEpsilon', RAY_EPSILON * this.meshRadius);
    // Ray mode: numSamples is the per-frame count and frameIndex counts those
    // frames, so the shader walks the same sample sequence as a full pass.
    prog.u.i('numSamples', this.samplesPerFrame());
    prog.u.i('frameIndex', this.accumFrame);
    prog.u.i('bvhNodes', BVH_NODE_UNIT);
    prog.u.i('bvhTris', BVH_TRI_UNIT);
    if (occlusionMode === 2 && this.bvhTextures) {
      gl.activeTexture(gl.TEXTURE0 + BVH_NODE_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, this.bvhTextures.nodes);
      gl.activeTexture(gl.TEXTURE0 + BVH_TRI_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, this.bvhTextures.tris);
    }
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
    this.cache.applyParams(prog.u, pkg.instance, textured);
    if (normalMap && this.meshHasUVs) {
      this.cache.bindImage(NORMAL_MAP_UNIT, normalMap);
      prog.u.i('normalMap', NORMAL_MAP_UNIT);
      prog.u.f('useNormalMap', 1);
      prog.u.f('normalFlipY', normalMap.flipY ? -1 : 1);
      prog.u.f('normalStrength', normalMap.strength);
    } else {
      prog.u.f('useNormalMap', 0);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posVBO);
    gl.enableVertexAttribArray(prog.posLoc);
    gl.vertexAttribPointer(prog.posLoc, 3, gl.FLOAT, false, 0, 0);
    const normalLoc = gl.getAttribLocation(prog.program, 'vtx_normal');
    if (normalLoc >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.normalVBO);
      gl.enableVertexAttribArray(normalLoc);
      gl.vertexAttribPointer(normalLoc, 3, gl.FLOAT, false, 0, 0);
    }
    const uvLoc = gl.getAttribLocation(prog.program, 'vtx_uv');
    if (uvLoc >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.uvVBO);
      gl.enableVertexAttribArray(uvLoc);
      gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 0, 0);
    }
    const tangentLoc = gl.getAttribLocation(prog.program, 'vtx_tangent');
    if (tangentLoc >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.tangentVBO);
      gl.enableVertexAttribArray(tangentLoc);
      gl.vertexAttribPointer(tangentLoc, 4, gl.FLOAT, false, 0, 0);
    }
    for (let i = 0; i < OCCLUSION_SH_COEFFS / 4; i++) {
      const occLoc = gl.getAttribLocation(prog.program, `vtx_occ${i}`);
      if (occLoc < 0) continue;
      if (this.meshHasOcclusion) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.occlusionVBO);
        gl.enableVertexAttribArray(occLoc);
        gl.vertexAttribPointer(occLoc, 4, gl.FLOAT, false, OCCLUSION_SH_COEFFS * 4, i * 16);
      } else {
        gl.disableVertexAttribArray(occLoc);
        gl.vertexAttrib4f(occLoc, 0, 0, 0, 0);
      }
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
    this.sceneTarget = createRenderTarget(this.gl, w, h, this.floatRenderTargets ? 'half' : 'byte', true);
    // 32-bit float running average: Ray mode accumulates thousands of frames,
    // where a half-float average would stop picking up new samples.
    this.accumTargets = [
      createRenderTarget(this.gl, w, h, this.floatRenderTargets ? 'float' : 'byte', false),
      createRenderTarget(this.gl, w, h, this.floatRenderTargets ? 'float' : 'byte', false),
    ];
    this.resetAccumulation();
  }

  private drawTextureToScreen(texture: WebGLTexture, w: number, h: number): void {
    this.drawDisplay(texture, null, w, h);
  }

  /** Draw a linear texture with exposure / gamma / tone map into `framebuffer` (null = the canvas). */
  private drawDisplay(texture: WebGLTexture, framebuffer: WebGLFramebuffer | null, w: number, h: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.useProgram(this.display.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    this.display.u.i('sourceTex', 0);
    this.display.u.f('gamma', this.gamma);
    this.display.u.f('exposure', this.exposure);
    this.toneMapper.apply(this.display.u, this.displayMode());
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
      pkg
        ? [
            pkg.instance.id,
            [...pkg.instance.values],
            [...(pkg.instance.textures ?? [])].map(([k, t]) => [k, t.url, t.channel, t.colorSpace]),
            pkg.instance.normalMap ? [pkg.instance.normalMap.url, pkg.instance.normalMap.flipY, pkg.instance.normalMap.strength] : null,
          ]
        : null,
      this.renderWithIBL ? null : [s.incidentTheta, s.incidentPhi, s.useNDotL],
    ]);
  }

  private resetAccumulation(): void {
    this.accumFrame = 0;
    this.accumRead = 0;
    this.requestRender();
  }

  /**
   * Expose the accumulation progress on the canvas for tools and tests:
   * data-accum-frames = frames averaged so far (0 without IBL), data-accum-state =
   * "running" | "stopped" (early stop: the displayed image no longer changes) | "done" (all passes).
   */
  private updateAccumStatus(frames: number): void {
    const state = !this.renderWithIBL || frames >= this.maxAccumFrames() ? 'done' : this.autoStop.stopped ? 'stopped' : 'running';
    const data = this.canvas.dataset;
    if (data.accumState !== state) data.accumState = state;
    const text = String(frames);
    if (data.accumFrames !== text) data.accumFrames = text;
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
    this.sss?.dispose();
    this.disposeTarget(this.autoStopProbe);
  }

  private setMesh(mesh: IndexedMesh): void {
    const gl = this.gl;
    this.meshData = mesh;
    this.meshGeneration++;
    this.deleteBvh();
    let radius = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      radius = Math.max(radius, Math.hypot(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]));
    }
    this.meshRadius = radius || 1;
    // a new mesh brings its own real size (pseudo SSS); applyViewState may override it afterwards
    this.meshSizeCm = clampSize(mesh.sourceSizeCm ?? DEFAULT_SIZE_CM);
    this.sizeCm = this.meshSizeCm;
    this.indexCount = mesh.indices.length;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posVBO);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.normalVBO);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.normals ?? mesh.positions, gl.STATIC_DRAW);
    this.meshHasUVs = !!mesh.uvs;
    this.warnedNoUVs = false;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvVBO);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.uvs ?? new Float32Array((mesh.positions.length / 3) * 2), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.tangentVBO);
    gl.bufferData(gl.ARRAY_BUFFER, computeTangents(mesh) ?? new Float32Array((mesh.positions.length / 3) * 4), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxVBO);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

    const t0 = performance.now();
    const occlusion = bakeOcclusionSH(gl, {
      positions: mesh.positions,
      normals: mesh.normals ?? mesh.positions,
      posVBO: this.posVBO,
      idxVBO: this.idxVBO,
      indexCount: this.indexCount,
    });
    this.meshHasOcclusion = !!occlusion;
    if (occlusion) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.occlusionVBO);
      gl.bufferData(gl.ARRAY_BUFFER, occlusion, gl.STATIC_DRAW);
      console.info(`[brdfView] Lit Object: occlusion baked for ${mesh.positions.length / 3} vertices in ${(performance.now() - t0).toFixed(0)} ms`);
    } else {
      console.warn('[brdfView] Lit Object: occlusion bake unavailable; rendering without self-occlusion');
    }
    if (this.occlusion === 'ray') void this.ensureBvh();
  }

  /**
   * Build (in a worker) and upload the current mesh's BVH for Ray mode, once per
   * mesh. Until it is ready, Ray mode draws with SH; when it arrives the
   * accumulation restarts.
   */
  private ensureBvh(): Promise<void> {
    if (this.bvhBuild) return this.bvhBuild;
    const mesh = this.meshData;
    if (!mesh) return Promise.resolve();
    const generation = this.meshGeneration;
    const t0 = performance.now();
    this.bvhBuild = buildBvhAsync(mesh.positions, mesh.indices, mesh.normals)
      .then((bvh) => {
        if (generation !== this.meshGeneration || !bvh) return;
        this.uploadBvh(bvh);
        console.info(
          `[brdfView] Lit Object: BVH for ${bvh.triCount} triangles (${bvh.nodeCount} nodes, depth ${bvh.depth}) in ${(performance.now() - t0).toFixed(0)} ms`,
        );
        if (this.occlusion === 'ray') this.resetAccumulation();
      })
      .catch((e) => console.error('[brdfView] Lit Object: BVH build failed; Ray occlusion falls back to SH', e));
    return this.bvhBuild;
  }

  private uploadBvh(bvh: PackedBvh): void {
    const gl = this.gl;
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (bvh.nodeRows > maxSize || bvh.triRows > maxSize) {
      console.warn('[brdfView] Lit Object: mesh too large for the BVH textures; Ray occlusion falls back to SH');
      return;
    }
    const upload = (data: Float32Array, rows: number): WebGLTexture => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, BVH_TEXTURE_WIDTH, rows, 0, gl.RGBA, gl.FLOAT, data);
      return t;
    };
    this.bvhTextures = { nodes: upload(bvh.nodes, bvh.nodeRows), tris: upload(bvh.tris, bvh.triRows) };
  }

  private deleteBvh(): void {
    if (this.bvhTextures) {
      this.gl.deleteTexture(this.bvhTextures.nodes);
      this.gl.deleteTexture(this.bvhTextures.tris);
    }
    this.bvhTextures = null;
    this.bvhBuild = null;
  }

  private loadEnvironment(name: string): Promise<void> {
    const p = this.loadEnvironmentNow(name);
    this.pendingLoad = this.pendingLoad.then(() => p);
    return p;
  }

  private warnedNoUVs = false;
  private warnNoUVs(): void {
    if (this.warnedNoUVs) return;
    this.warnedNoUVs = true;
    console.warn(`[brdfView] Lit Object: "${this.meshName}" has no texture coordinates; parameter images and normal maps cannot be mapped`);
  }

  /** Whether the current mesh has texture coordinates. */
  hasUVs(): boolean {
    return this.meshHasUVs;
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
    // setMesh changes the size shown in the controls
    const refreshControls = () => {
      this.closeEnvironmentMenu();
      this.footer.replaceChildren();
      this.buildControls();
    };
    if (name === 'sphere') {
      this.meshName = name;
      this.setMesh(buildSphere(1.0, 100, 100));
      refreshControls();
      this.resetAccumulation();
      return;
    }
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}obj/${name}`);
      if (!res.ok) throw new Error(`${res.status}`);
      this.meshName = name;
      this.setMesh(parseObjMesh(await res.text()));
      refreshControls();
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
      boolControl(
        'SSS',
        this.sssEnabled,
        (v) => {
          this.sssEnabled = v;
          this.resetAccumulation();
        },
        '疑似 SSS（独自実装・近似）: 拡散光だけを画面上でぼかす表面下散乱。sss_ で始まるパラメータで調整。対応する .brdf（BRDF_sss_diffuse を持つもの）でのみ有効 / ' +
          'Pseudo SSS (custom approximation): screen-space subsurface scattering that blurs only the diffuse light; tuned by the sss_ parameters. Only for a .brdf that declares BRDF_sss_diffuse.',
      ),
    );
    const sizeControl = floatControl(
      'Size (cm)',
      this.sizeCm,
      1,
      100,
      this.meshSizeCm,
      (v) => {
        this.sizeCm = clampSize(v);
        this.requestRender();
      },
      '疑似 SSS 用: モデルの最大の辺の実寸（cm）。散乱の距離（cm）を画面上の大きさに直すのに使う / ' +
        'For the pseudo SSS: real size (cm) of the model\'s largest dimension; converts the scatter radius (cm) to screen size.',
    );
    const occlusionSelect = selectControl(
      'Occlusion',
      [
        { value: 'off', text: 'Off' },
        { value: 'sh', text: 'SH' },
        { value: 'ray', text: 'Ray' },
      ],
      this.occlusion,
      (v) => {
        this.occlusion = parseOcclusion(v) ?? this.occlusion;
        if (this.occlusion === 'ray') void this.ensureBvh();
        this.resetAccumulation();
      },
      'IBL のみ: メッシュ自身による遮蔽。SH = 読み込み時に頂点ごとに事前計算した近似、Ray = サンプルごとに影のレイを飛ばす正確な判定（収束に時間がかかる）/ ' +
        'IBL only: self-occlusion from the mesh. SH = approximation baked per vertex at load, Ray = exact shadow ray per sample (slower to converge).',
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
      occlusionSelect,
      sizeControl,
      floatControl('Gamma', this.gamma, 0.1, 5, 2.2, (v) => {
        this.gamma = v;
        this.requestRender();
      }),
      floatControl('Exposure', this.exposure, -10, 10, 0, (v) => {
        this.exposure = v;
        this.requestRender();
      }),
    );
    this.syncToneMapControls();
    this.syncSssControls();
  }

  /** The SSS checkbox and the size are only usable with a .brdf that supports the pseudo SSS. */
  private syncSssControls(): void {
    const available = this.sssAvailable();
    for (const id of ['ctl-sss', 'ctl-size-cm']) {
      const row = this.footer.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (!row) continue;
      for (const input of row.querySelectorAll('input')) input.disabled = !available;
      row.classList.toggle('ctl-disabled', !available);
    }
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
      if (this.interacting) {
        this.interacting = false;
        // Ray mode previewed with SH during the drag: restart with rays.
        if (this.occlusion === 'ray') this.resetAccumulation();
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (button < 0) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      this.interacting = true;
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

function clampSize(cm: number): number {
  return Math.max(MIN_SIZE_CM, Math.min(MAX_SIZE_CM, cm));
}

/** "off" / "sh" / "ray"; older states store a boolean (true = SH, false = off). */
function parseOcclusion(v: unknown): OcclusionMode | undefined {
  if (typeof v === 'string' && (OCCLUSION_MODES as readonly string[]).includes(v.toLowerCase())) {
    return v.toLowerCase() as OcclusionMode;
  }
  const b = bool({ v }, 'v');
  return b === undefined ? undefined : b ? 'sh' : 'off';
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
  format: 'byte' | 'half' | 'float',
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
  const [internalFormat, type] =
    format === 'float' ? [gl.RGBA32F, gl.FLOAT] : format === 'half' ? [gl.RGBA16F, gl.HALF_FLOAT] : [gl.RGBA8, gl.UNSIGNED_BYTE];
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, gl.RGBA, type, null);

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
${TONEMAP_GLSL}
uniform sampler2D sourceTex;
uniform float gamma;
uniform float exposure;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec4 src = texture(sourceTex, vUv);
  vec3 c = max(src.rgb, vec3(0.0));
  c *= pow(2.0, exposure);
  // alpha is 1 except in snapshots with a transparent / solid background
  fragColor = vec4(displayLimit(displayEncode(c, gamma)), clamp(src.a, 0.0, 1.0));
}
`;
