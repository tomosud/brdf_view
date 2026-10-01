// Pseudo SSS for Lit Object: a screen-space separable subsurface-scattering
// post-process (CUSTOM IMPLEMENTATION / approximation, see docs/pseudo_sss.md).
//
// The idea is the one used by UE4-style Subsurface Profiles: light the surface,
// keep the diffuse lighting (before albedo) apart from the specular, blur only
// the diffuse with a per-channel kernel whose size is fixed in world units,
// then recombine:
//
//   final = mix(diffuse, blurred, subsurfaceColor) * albedo + specular
//
// Everything specific to the feature lives in this file, so it can be switched
// off or removed without touching the regular Lit Object path:
//   - which .brdf files support it (two optional hook functions, sssSupport)
//   - where its values come from (.brdf parameters named sss_*, sssParamsOf)
//   - the kernel (separableKernel) and the GPU passes (SssPipeline)
// lit-object.ts only decides when to use it and draws the scene into
// SssPipeline's three render targets instead of its own single one.

import { buildProgram, Uniforms } from './renderer.js';
import type { BrdfDef, BrdfInstance } from '../brdf/types.js';

// ---------------------------------------------------------------------------
// .brdf side

/** Optional hook: diffuse term of BRDF() WITHOUT the albedo factor. Its presence enables the feature. */
export const SSS_HOOK_DIFFUSE = 'BRDF_sss_diffuse';
/** Optional hook: albedo applied after scattering. Without it the albedo is 1 (BRDF_sss_diffuse then includes it). */
export const SSS_HOOK_ALBEDO = 'BRDF_sss_albedo';

export interface SssSupport {
  /** The .brdf declares `vec3 BRDF_sss_diffuse(vec3 L, vec3 V, vec3 N, vec3 X, vec3 Y)`. */
  diffuse: boolean;
  /** The .brdf declares `vec3 BRDF_sss_albedo()`. */
  albedo: boolean;
}

const supportCache = new WeakMap<BrdfDef, SssSupport>();

/** Which pseudo-SSS hooks a .brdf declares (measured BRDFs never do). */
export function sssSupport(def: BrdfDef): SssSupport {
  let s = supportCache.get(def);
  if (!s) {
    const declares = (name: string) => new RegExp(`\\bvec3\\s+${name}\\s*\\(`).test(def.shaderSource);
    s = def.measured ? { diffuse: false, albedo: false } : { diffuse: declares(SSS_HOOK_DIFFUSE), albedo: declares(SSS_HOOK_ALBEDO) };
    supportCache.set(def, s);
  }
  return s;
}

/** Preprocessor lines for templates with ::INSERT_DEFINES_HERE:: ('' when the .brdf has no hooks). */
export function sssDefines(def: BrdfDef): string {
  const s = sssSupport(def);
  if (!s.diffuse) return '';
  return `#define BRDF_SSS 1${s.albedo ? '\n#define BRDF_SSS_HAS_ALBEDO 1' : ''}`;
}

/** Scattering values, read from the .brdf parameters named below. */
export interface SssParams {
  /** Per-pixel scatter strength: multiplies the radius (0 = no scattering). */
  strength: number;
  /** Distance the kernel reaches, in cm, at strength 1. */
  radiusCm: number;
  /** Per-channel width of the profile relative to the radius (0-1). */
  falloff: [number, number, number];
  /** Blend between the unscattered (0) and the scattered (1) diffuse, per channel. */
  subsurface: [number, number, number];
}

/** Parameter names the feature reads from a .brdf (all optional, floats). */
export const SSS_PARAM_NAMES = {
  strength: 'sss_strength',
  radiusCm: 'sss_scatter_radius',
  falloff: ['sss_falloff_r', 'sss_falloff_g', 'sss_falloff_b'],
  subsurface: ['sss_subsurface_r', 'sss_subsurface_g', 'sss_subsurface_b'],
} as const;

/** Used for parameters a .brdf does not declare (the values of a default UE Subsurface Profile). */
export const SSS_DEFAULTS: SssParams = {
  strength: 1,
  radiusCm: 1.2,
  falloff: [1.0, 0.37, 0.3],
  subsurface: [0.48, 0.41, 0.28],
};

export function sssParamsOf(inst: BrdfInstance): SssParams {
  const f = (name: string, fallback: number): number => {
    const v = inst.values.get(name);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const p = inst.def.params.find((x) => x.name === name);
    return p && p.kind === 'float' ? p.default : fallback;
  };
  const n = SSS_PARAM_NAMES;
  const d = SSS_DEFAULTS;
  return {
    strength: Math.max(0, f(n.strength, d.strength)),
    radiusCm: Math.max(0, f(n.radiusCm, d.radiusCm)),
    falloff: [f(n.falloff[0], d.falloff[0]), f(n.falloff[1], d.falloff[1]), f(n.falloff[2], d.falloff[2])],
    subsurface: [
      clamp01(f(n.subsurface[0], d.subsurface[0])),
      clamp01(f(n.subsurface[1], d.subsurface[1])),
      clamp01(f(n.subsurface[2], d.subsurface[2])),
    ],
  };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// ---------------------------------------------------------------------------
// kernel

/** Number of kernel taps (centre + one side). Must match the shader. */
export const SSS_KERNEL_TAPS = 13;
/** Offset of the last tap in kernel units; it maps to the scatter radius. */
export const SSS_KERNEL_RANGE = 3.0;
/** Depth weight exp(-SSS_DEPTH_FALLOFF * dz^2), dz in cm: keeps the blur on one surface. */
export const SSS_DEPTH_FALLOFF = 0.01;
const FALLOFF_MIN = 0.009;

// Skin diffusion profile as a sum of Gaussians (weight, variance), d'Eon & Luebke
// (GPU Gems 3, ch. 14). The narrowest one (0.233, 0.0064) is left out: it is
// treated as light that does not scatter.
const GAUSSIANS: readonly (readonly [number, number])[] = [
  [0.1, 0.0484],
  [0.118, 0.187],
  [0.113, 0.567],
  [0.358, 1.99],
  [0.078, 7.41],
];

function profile(r: number, falloff: number): number {
  const rr = r / (0.001 + falloff);
  let sum = 0;
  for (const [w, v] of GAUSSIANS) sum += (w * Math.exp(-(rr * rr) / (2 * v))) / (2 * Math.PI * v);
  return sum;
}

/**
 * Separable (sum-of-Gaussians) kernel after Jimenez's Separable SSS: `taps`
 * entries [r, g, b, offset] for the centre and the positive side. Offsets run
 * 0..SSS_KERNEL_RANGE (denser near the centre); weights are "interval width x
 * profile" and sum to 1 per channel over the mirrored kernel.
 * scripts/verify_sss.py holds the same code in Python.
 */
export function separableKernel(falloff: readonly [number, number, number], taps = SSS_KERNEL_TAPS): number[][] {
  const fall = falloff.map((f) => Math.max(f, FALLOFF_MIN));
  const total = 2 * taps - 1;
  const range = total > 20 ? 3.0 : 2.0;
  const step = (2 * range) / (total - 1);
  const offs: number[] = [];
  for (let i = 0; i < total; i++) {
    const o = -range + i * step;
    offs.push((range * Math.sign(o) * o * o) / (range * range));
  }
  const rgb: number[][] = [];
  for (let i = 0; i < total; i++) {
    const w0 = i > 0 ? Math.abs(offs[i] - offs[i - 1]) : 0;
    const w1 = i < total - 1 ? Math.abs(offs[i] - offs[i + 1]) : 0;
    const area = (w0 + w1) / 2;
    rgb.push(fall.map((f) => area * profile(offs[i], f)));
  }
  const sums = [0, 1, 2].map((c) => rgb.reduce((s, k) => s + k[c], 0));
  const mid = taps - 1;
  const out: number[][] = [];
  for (let i = 0; i < taps; i++) {
    const k = rgb[mid + i];
    out.push([k[0] / sums[0], k[1] / sums[1], k[2] / sums[2], Math.abs(offs[mid + i])]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// GPU passes

/** Colour attachments of the scene target (the .frag outputs of iblObject.frag with BRDF_SSS). */
export const SSS_ATTACHMENT_SPECULAR = 0; // rgb: specular + everything that is not scattered (background); a: coverage
export const SSS_ATTACHMENT_DIFFUSE = 1; // rgb: diffuse light before albedo; a: view depth in scene units (0 = no surface)
export const SSS_ATTACHMENT_ALBEDO = 2; // rgb: albedo applied after scattering
const ATTACHMENTS = 3;

interface MrtTarget {
  framebuffer: WebGLFramebuffer;
  textures: WebGLTexture[];
  depth: WebGLRenderbuffer | null;
}

export interface SssResolveInput {
  params: SssParams;
  /** Centimetres per scene unit (model size in cm / model size in scene units). */
  cmPerUnit: number;
  /** Projection scale: pixels per scene unit at view depth 1 (0.5 * height * proj[1][1]). */
  pixelsPerUnitAtDepth1: number;
  /** Sub-steps between neighbouring kernel taps (quality; 4 while moving, 8 for stills). */
  subSteps: number;
}

export class SssPipeline {
  private scene: MrtTarget | null = null;
  private accum: [MrtTarget, MrtTarget] | null = null;
  private blur: [MrtTarget, MrtTarget] | null = null;
  private composite: MrtTarget | null = null;
  private accumRead = 0;
  private width = 0;
  private height = 0;
  private readonly vao: WebGLVertexArrayObject;
  private readonly accumProgram: { program: WebGLProgram; u: Uniforms };
  private readonly blurProgram: { program: WebGLProgram; u: Uniforms };
  private readonly combineProgram: { program: WebGLProgram; u: Uniforms };
  private kernelKey = '';
  private kernelData = new Float32Array(SSS_KERNEL_TAPS * 4);

  /** Requires float render targets (EXT_color_buffer_float); the caller checks. */
  constructor(private gl: WebGL2RenderingContext) {
    this.vao = gl.createVertexArray()!;
    const make = (frag: string, label: string) => {
      const program = buildProgram(gl, FULLSCREEN_VERT, frag, label);
      return { program, u: new Uniforms(gl, program) };
    };
    this.accumProgram = make(ACCUM_FRAG, 'sssAccumulate');
    this.blurProgram = make(BLUR_FRAG, 'sssBlur');
    this.combineProgram = make(COMBINE_FRAG, 'sssCombine');
  }

  /** (Re)allocate the targets for a width x height view. Returns true when they were recreated. */
  ensure(width: number, height: number): boolean {
    if (this.scene && this.width === width && this.height === height) return false;
    this.disposeTargets();
    const gl = this.gl;
    this.width = width;
    this.height = height;
    this.scene = createTarget(gl, width, height, ATTACHMENTS, 'half', true);
    // 32-bit float running averages, like the regular accumulation targets.
    this.accum = [createTarget(gl, width, height, ATTACHMENTS, 'float', false), createTarget(gl, width, height, ATTACHMENTS, 'float', false)];
    this.blur = [createTarget(gl, width, height, 1, 'half', false), createTarget(gl, width, height, 1, 'half', false)];
    this.composite = createTarget(gl, width, height, 1, 'half', false);
    this.accumRead = 0;
    return true;
  }

  /** Bind the scene target and clear it (clearAlpha = coverage of the empty background). */
  beginScene(clearAlpha: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene!.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    this.selectSceneOutputs(false);
    gl.clearBufferfv(gl.COLOR, SSS_ATTACHMENT_SPECULAR, [0, 0, 0, clearAlpha]);
    gl.clearBufferfv(gl.COLOR, SSS_ATTACHMENT_DIFFUSE, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.COLOR, SSS_ATTACHMENT_ALBEDO, [0, 0, 0, 0]);
    gl.clear(gl.DEPTH_BUFFER_BIT);
  }

  /**
   * Which attachments the next draws write. The background shader has a single
   * output, so it must only reach the specular attachment (true); the object
   * shader writes all three (false).
   */
  selectSceneOutputs(backgroundOnly: boolean): void {
    const gl = this.gl;
    gl.drawBuffers(
      backgroundOnly ? [gl.COLOR_ATTACHMENT0, gl.NONE, gl.NONE] : [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2],
    );
  }

  /** Fold the scene target into the running average (frameIndex 0 restarts it). */
  accumulate(frameIndex: number): void {
    const gl = this.gl;
    const write = this.accumRead === 0 ? 1 : 0;
    const prev = this.accum![this.accumRead];
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accum![write].framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.useProgram(this.accumProgram.program);
    for (let i = 0; i < ATTACHMENTS; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, prev.textures[i]);
      this.accumProgram.u.i(`previousTex${i}`, i);
      gl.activeTexture(gl.TEXTURE0 + ATTACHMENTS + i);
      gl.bindTexture(gl.TEXTURE_2D, this.scene!.textures[i]);
      this.accumProgram.u.i(`currentTex${i}`, ATTACHMENTS + i);
    }
    this.accumProgram.u.i('frameIndex', frameIndex);
    this.fullscreen();
    gl.depthMask(true);
    this.accumRead = write;
  }

  /**
   * Blur the diffuse (horizontal, then vertical) and recombine. `source` is the
   * scene target itself (one directional light) or the running average (IBL).
   * Returns a texture holding the final linear colour (alpha = coverage).
   */
  resolve(source: 'scene' | 'accum', input: SssResolveInput): WebGLTexture {
    const gl = this.gl;
    const src = source === 'scene' ? this.scene! : this.accum![this.accumRead];
    const { params } = input;
    this.updateKernel(params);

    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.viewport(0, 0, this.width, this.height);

    // pixels per cm at view depth 1 (same horizontally and vertically: square pixels)
    const pixelsPerCm = input.pixelsPerUnitAtDepth1 / Math.max(input.cmPerUnit, 1e-6);
    const blur = this.blurProgram;
    gl.useProgram(blur.program);
    gl.uniform4fv(blur.u.loc('kernel[0]'), this.kernelData);
    blur.u.f('cmPerUnit', input.cmPerUnit);
    blur.u.f('depthFalloff', SSS_DEPTH_FALLOFF);
    blur.u.i('subSteps', Math.max(1, Math.min(16, Math.round(input.subSteps))));
    blur.u.i('sourceTex', 0);
    gl.activeTexture(gl.TEXTURE0);
    const passes: [WebGLTexture, MrtTarget, number, number][] = [
      [src.textures[SSS_ATTACHMENT_DIFFUSE], this.blur![0], pixelsPerCm, 0],
      [this.blur![0].textures[0], this.blur![1], 0, pixelsPerCm],
    ];
    for (const [tex, target, sx, sy] of passes) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      blur.u.v2('stepAtDepth1', sx, sy);
      this.fullscreen();
    }

    const combine = this.combineProgram;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.composite!.framebuffer);
    gl.useProgram(combine.program);
    const inputs: [string, WebGLTexture][] = [
      ['specularTex', src.textures[SSS_ATTACHMENT_SPECULAR]],
      ['diffuseTex', src.textures[SSS_ATTACHMENT_DIFFUSE]],
      ['albedoTex', src.textures[SSS_ATTACHMENT_ALBEDO]],
      ['blurredTex', this.blur![1].textures[0]],
    ];
    inputs.forEach(([name, tex], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      combine.u.i(name, i);
    });
    combine.u.v3('subsurfaceColor', params.subsurface[0], params.subsurface[1], params.subsurface[2]);
    this.fullscreen();

    gl.depthMask(true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.composite!.textures[0];
  }

  dispose(): void {
    this.disposeTargets();
  }

  private updateKernel(params: SssParams): void {
    const key = `${params.falloff.join(',')}|${params.radiusCm}|${params.strength}`;
    if (key === this.kernelKey) return;
    this.kernelKey = key;
    const cmPerKernelUnit = (params.radiusCm / SSS_KERNEL_RANGE) * params.strength;
    separableKernel(params.falloff).forEach((k, i) => {
      this.kernelData.set([k[0], k[1], k[2], k[3] * cmPerKernelUnit], i * 4);
    });
  }

  private fullscreen(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  private disposeTargets(): void {
    const gl = this.gl;
    for (const t of [this.scene, this.composite, ...(this.accum ?? []), ...(this.blur ?? [])]) {
      if (!t) continue;
      gl.deleteFramebuffer(t.framebuffer);
      for (const tex of t.textures) gl.deleteTexture(tex);
      if (t.depth) gl.deleteRenderbuffer(t.depth);
    }
    this.scene = this.composite = this.accum = this.blur = null;
  }
}

function createTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  attachments: number,
  format: 'half' | 'float',
  withDepth: boolean,
): MrtTarget {
  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) throw new Error('failed to create SSS framebuffer');
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  const textures: WebGLTexture[] = [];
  const [internalFormat, type] = format === 'float' ? [gl.RGBA32F, gl.FLOAT] : [gl.RGBA16F, gl.HALF_FLOAT];
  for (let i = 0; i < attachments; i++) {
    const texture = gl.createTexture();
    if (!texture) throw new Error('failed to create SSS texture');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, gl.RGBA, type, null);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, texture, 0);
    textures.push(texture);
  }
  gl.drawBuffers(textures.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
  let depth: WebGLRenderbuffer | null = null;
  if (withDepth) {
    depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  }
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`SSS framebuffer incomplete: ${status}`);
  return { framebuffer, textures, depth };
}

const FULLSCREEN_VERT = `#version 300 es
precision highp float;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

// Running average of the three scene attachments (one output per attachment).
const ACCUM_FRAG = `#version 300 es
precision highp float;
uniform sampler2D previousTex0;
uniform sampler2D previousTex1;
uniform sampler2D previousTex2;
uniform sampler2D currentTex0;
uniform sampler2D currentTex1;
uniform sampler2D currentTex2;
uniform int frameIndex;
layout(location = 0) out vec4 out0;
layout(location = 1) out vec4 out1;
layout(location = 2) out vec4 out2;
vec4 average(sampler2D previousTex, sampler2D currentTex, ivec2 p) {
  vec4 current = texelFetch(currentTex, p, 0);
  if (frameIndex == 0) return current;
  float n = float(frameIndex);
  return (texelFetch(previousTex, p, 0) * n + current) / (n + 1.0);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  out0 = average(previousTex0, currentTex0, p);
  out1 = average(previousTex1, currentTex1, p);
  out2 = average(previousTex2, currentTex2, p);
}
`;

// One 1D pass of the separable kernel along stepAtDepth1 (pixels per cm at view
// depth 1; divided by the pixel's depth, so the kernel has a fixed size in cm).
// Between two neighbouring kernel taps the position and the weight are
// interpolated in subSteps steps, which turns the 13 taps into a continuous
// kernel (the expectation of jittering each tap between its neighbours).
// Samples off the surface (depth 0) are skipped and the rest is weighted by
// exp(-depthFalloff * dz^2); the result is normalized by the weights used.
const BLUR_FRAG = `#version 300 es
precision highp float;
precision highp int;
#define TAPS ${SSS_KERNEL_TAPS}
uniform sampler2D sourceTex;   // rgb: diffuse light, a: view depth (0 = no surface)
uniform vec4 kernel[TAPS];     // rgb: weight, a: offset in cm
uniform vec2 stepAtDepth1;
uniform float cmPerUnit;
uniform float depthFalloff;
uniform int subSteps;
out vec4 fragColor;
void main() {
  ivec2 size = textureSize(sourceTex, 0);
  vec4 centre = texelFetch(sourceTex, ivec2(gl_FragCoord.xy), 0);
  if (centre.a <= 0.0) {
    fragColor = vec4(0.0);
    return;
  }
  vec2 stepPx = stepAtDepth1 / centre.a;
  vec3 acc = vec3(0.0);
  vec3 div = vec3(0.0);
  for (int i = 0; i < TAPS - 1; i++) {
    for (int s = 0; s < subSteps; s++) {
      vec4 k = mix(kernel[i], kernel[i + 1], (float(s) + 0.5) / float(subSteps));
      for (int side = -1; side <= 1; side += 2) {
        ivec2 q = ivec2(floor(gl_FragCoord.xy + float(side) * k.a * stepPx));
        if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) continue;
        vec4 c = texelFetch(sourceTex, q, 0);
        if (c.a <= 0.0) continue;
        float dz = (c.a - centre.a) * cmPerUnit;
        float w = exp(-depthFalloff * dz * dz);
        acc += k.rgb * c.rgb * w;
        div += k.rgb * w;
      }
    }
  }
  vec3 blurred = vec3(div.r > 0.0 ? acc.r / div.r : centre.r, div.g > 0.0 ? acc.g / div.g : centre.g, div.b > 0.0 ? acc.b / div.b : centre.b);
  fragColor = vec4(blurred, centre.a);
}
`;

const COMBINE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D specularTex;
uniform sampler2D diffuseTex;
uniform sampler2D albedoTex;
uniform sampler2D blurredTex;
uniform vec3 subsurfaceColor;
out vec4 fragColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 specular = texelFetch(specularTex, p, 0);
  vec3 diffuse = texelFetch(diffuseTex, p, 0).rgb;
  vec3 blurred = texelFetch(blurredTex, p, 0).rgb;
  vec3 albedo = texelFetch(albedoTex, p, 0).rgb;
  fragColor = vec4(mix(diffuse, blurred, subsurfaceColor) * albedo + specular.rgb, specular.a);
}
`;
