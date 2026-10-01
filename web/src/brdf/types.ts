// Data model for parsed .brdf definitions and live BRDF instances.
// Mirrors the original parameter taxonomy in BRDFBase.cpp (float / bool / color).

export interface FloatParam {
  kind: 'float';
  name: string;
  min: number;
  max: number;
  default: number;
  /** Optional trailing `# comment` from the .brdf parameter line, shown as a tooltip. */
  description?: string;
}

export interface BoolParam {
  kind: 'bool';
  name: string;
  default: boolean;
  /** Optional trailing `# comment` from the .brdf parameter line, shown as a tooltip. */
  description?: string;
}

export interface ColorParam {
  kind: 'color';
  name: string;
  default: [number, number, number];
  /** Optional trailing `# comment` from the .brdf parameter line, shown as a tooltip. */
  description?: string;
}

export type ParamDef = FloatParam | BoolParam | ColorParam;

export type ParamValue = number | boolean | [number, number, number];

/** Float data for a measured (MERL) BRDF, packed into an R32F texture. */
export interface MeasuredData {
  /** 3*N floats: R block, G block, B block (MERL layout). */
  data: Float32Array;
  texWidth: number;
  texHeight: number;
}

/** A parsed .brdf file: parameter declarations + raw GLSL fragments (preserved verbatim). */
export interface BrdfDef {
  /** User-facing display name, normally derived from the file name. */
  name: string;
  params: ParamDef[];
  /** Tracks where this BRDF came from so IndexedDB can restore it on reload. */
  origin?: { kind: 'bundled'; filename: string } | { kind: 'text'; name: string; content: string };
  /** Raw GLSL body that defines `vec3 BRDF(vec3 L, vec3 V, vec3 N, vec3 X, vec3 Y)`. */
  shaderSource: string;
  /** Raw GLSL importance-sampling fragment (IBL); preserved but unused in this milestone. */
  isFuncSource: string | null;
  /**
   * Skip the int->float literal promotion pass (shaderSource is already valid
   * GLSL ES 3.00). Used for built-in shaders like the measured BRDF, whose
   * integer index arithmetic must stay integer.
   */
  noPromote?: boolean;
  /** Present for measured BRDFs: the data uploaded to a sampler2D `measuredData`. */
  measured?: MeasuredData;
}

/** A decoded image file used as a texture (Lit Object only). */
export interface TextureImage {
  /** Stable id of the image data (IndexedDB key of `blob`). */
  id: string;
  /** The original file data, kept for saving to IndexedDB. */
  blob: Blob;
  fileName: string;
  image: HTMLImageElement;
  /** Object URL of the image (thumbnail); revoked when the texture is removed. */
  url: string;
  width: number;
  height: number;
}

export type TextureChannel = 'rgb' | 'r' | 'g' | 'b' | 'a';
export type TextureColorSpace = 'srgb' | 'linear';

/**
 * An image attached to a float/color parameter. In Lit Object the parameter is
 * read from the image per pixel (mesh UVs) instead of the slider value.
 * color parameters use RGB, float parameters one channel. `colorSpace` is the
 * image's encoding; values are converted to what the .brdf expects (color
 * parameters: sRGB like the color picker, float parameters: linear).
 */
export interface ParamTexture extends TextureImage {
  channel: TextureChannel;
  colorSpace: TextureColorSpace;
}

/** Tangent-space normal map; flipY = DirectX convention (the default). Lit Object only. */
export interface NormalMap extends TextureImage {
  flipY: boolean;
  strength: number;
}

/** A loaded BRDF together with its live UI state and current parameter values. */
export interface BrdfInstance {
  id: string;
  def: BrdfDef;
  /** Current value per parameter name (seeded from defaults). */
  values: Map<string, ParamValue>;
  /** Enabled / drawn (original "visible"). */
  visible: boolean;
  /** Images attached to parameters (Lit Object only). Not part of state / links. */
  textures?: Map<string, ParamTexture>;
  /** Normal map for this BRDF (Lit Object only). Not part of state / links. */
  normalMap?: NormalMap;
}
