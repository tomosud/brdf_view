// Specular Glazing Blur for Lit Object: CUSTOM IMPLEMENTATION /
// approximation (see docs/glazing_blur.md). A reconstruction of the behaviour of
// a shipped renderer, not its original code.
//
// Near the light/dark boundary, each lighting sample evaluates the specular with
// the shading normal of a random nearby pixel and takes its shadow from that
// pixel's position; the accumulation averages the choices. The diffuse keeps the
// pixel's own normal. The reach is a world-space radius (cm) weighted by
// (1 - N.L)^4, so it only acts where the light grazes the surface.
//
// Everything specific to the feature lives in this file, so it can be switched
// off or removed without touching the regular Lit Object path:
//   - which .brdf files support it (glazingSupport)
//   - the G-buffer the lighting pass reads its neighbours from (GlazingGBuffer)
// iblObject.frag only differs inside #ifdef BRDF_GLAZING / GLAZING_GBUFFER;
// lit-object.ts only decides when to use it (IBL with ray-traced occlusion).

import type { Uniforms } from './renderer.js';
import type { BrdfDef } from '../brdf/types.js';
import { sssSupport } from './sss.js';

/** Float parameter (cm) a .brdf declares to opt in; 0 disables the effect. */
export const GLAZING_PARAM_RADIUS = 'glazing_blur_radius';
/** Optional float parameter that scales the radius (the strength of the Callisto terms). */
const GLAZING_PARAM_STRENGTH = 'advanced_strength';
/**
 * Optional tuning parameters: [shader macro, .brdf parameter, kind, value used when
 * the .brdf does not declare it]. The fallbacks are the reconstructed behaviour.
 */
const GLAZING_TUNING: readonly (readonly [string, string, 'float' | 'bool', string])[] = [
  // the radius is weighted by (1 - N.L)^power; 0 = the full radius everywhere
  ['GLAZING_GRAZE_POWER', 'glazing_graze_power', 'float', '4.0'],
  // offsets are spread as (u / 512)^power of the radius; higher = denser near the centre
  ['GLAZING_RADIUS_POWER', 'glazing_radius_power', 'float', '3.0'],
  // a neighbour is only used when its view depth is within this distance (cm)
  ['GLAZING_DEPTH_TOLERANCE_CM', 'glazing_depth_tolerance', 'float', '0.5'],
  ['GLAZING_BORROW_NORMAL', 'glazing_borrow_normal', 'bool', 'true'],
  ['GLAZING_BORROW_SHADOW', 'glazing_borrow_shadow', 'bool', 'true'],
];

/** Texture units of the G-buffer in the lighting pass (see the list in brdf-program.ts). */
const GLAZING_UNIT = 16;

const hasParam = (def: BrdfDef, name: string, kind: 'float' | 'bool') => def.params.some((p) => p.name === name && p.kind === kind);
const hasFloatParam = (def: BrdfDef, name: string) => hasParam(def, name, 'float');

/**
 * Whether a .brdf supports the feature: it declares the radius parameter and the
 * pseudo-SSS diffuse hook (needed to evaluate diffuse and specular with different normals).
 */
export function glazingSupport(def: BrdfDef): boolean {
  return hasFloatParam(def, GLAZING_PARAM_RADIUS) && sssSupport(def).diffuse;
}

/** Preprocessor lines for the lighting pass ('' when the .brdf does not support the feature). */
export function glazingDefines(def: BrdfDef): string {
  if (!glazingSupport(def)) return '';
  const lines = ['#define BRDF_GLAZING 1'];
  if (sssSupport(def).albedo) lines.push('#define BRDF_GLAZING_HAS_ALBEDO 1');
  if (hasFloatParam(def, GLAZING_PARAM_STRENGTH)) lines.push('#define BRDF_GLAZING_HAS_STRENGTH 1');
  for (const [macro, name, kind, fallback] of GLAZING_TUNING) lines.push(`#define ${macro} ${hasParam(def, name, kind) ? name : fallback}`);
  return lines.join('\n');
}

/** Preprocessor line that turns iblObject.frag into the G-buffer pre-pass. */
export const GLAZING_GBUFFER_DEFINES = '#define GLAZING_GBUFFER 1';

export interface GlazingShadingInput {
  camForward: readonly [number, number, number];
  /** Centimetres per scene unit (model size in cm / model size in scene units). */
  cmPerUnit: number;
  /** Projection scale: pixels per scene unit at view depth 1 (0.5 * height * proj[1][1]). */
  pixelsPerUnitAtDepth1: number;
}

/**
 * Three RGBA32F attachments written by iblObject.frag with GLAZING_GBUFFER:
 * 0 xyz shading normal (normal map applied), w view depth in scene units (0 = no surface);
 * 1 xyz world position; 2 xyz geometric normal (shadow-ray origin offset).
 */
export class GlazingGBuffer {
  private framebuffer: WebGLFramebuffer | null = null;
  private textures: WebGLTexture[] = [];
  private depth: WebGLRenderbuffer | null = null;
  private width = 0;
  private height = 0;

  /** Requires float render targets (EXT_color_buffer_float); the caller checks. */
  constructor(private gl: WebGL2RenderingContext) {}

  /** (Re)allocate for a width x height view. Returns true when the targets were recreated. */
  ensure(width: number, height: number): boolean {
    if (this.framebuffer && this.width === width && this.height === height) return false;
    this.dispose();
    const gl = this.gl;
    this.width = width;
    this.height = height;
    this.framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    for (let i = 0; i < 3; i++) {
      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, texture, 0);
      this.textures.push(texture);
    }
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    this.depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`glazing G-buffer incomplete: ${status}`);
    return true;
  }

  /** Bind and clear the G-buffer; the caller then draws the mesh with the GLAZING_GBUFFER program. */
  begin(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    for (let i = 0; i < 3; i++) gl.clearBufferfv(gl.COLOR, i, [0, 0, 0, 0]);
    gl.clear(gl.DEPTH_BUFFER_BIT);
  }

  /** Bind the G-buffer textures and set the BRDF_GLAZING uniforms of the lighting program in use. */
  bindForShading(u: Uniforms, input: GlazingShadingInput): void {
    const gl = this.gl;
    ['glazingNormalDepth', 'glazingPosition', 'glazingGeomNormal'].forEach((name, i) => {
      gl.activeTexture(gl.TEXTURE0 + GLAZING_UNIT + i);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[i]);
      u.i(name, GLAZING_UNIT + i);
    });
    u.v3('glazingCamForward', input.camForward[0], input.camForward[1], input.camForward[2]);
    u.f('glazingCmPerUnit', input.cmPerUnit);
    u.f('glazingPixelsPerCm', input.pixelsPerUnitAtDepth1 / Math.max(input.cmPerUnit, 1e-6));
  }

  dispose(): void {
    const gl = this.gl;
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
    for (const t of this.textures) gl.deleteTexture(t);
    if (this.depth) gl.deleteRenderbuffer(this.depth);
    this.framebuffer = null;
    this.textures = [];
    this.depth = null;
  }
}
