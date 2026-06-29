// Data model for parsed .brdf definitions and live BRDF instances.
// Mirrors the original parameter taxonomy in BRDFBase.cpp (float / bool / color).

export interface FloatParam {
  kind: 'float';
  name: string;
  min: number;
  max: number;
  default: number;
}

export interface BoolParam {
  kind: 'bool';
  name: string;
  default: boolean;
}

export interface ColorParam {
  kind: 'color';
  name: string;
  default: [number, number, number];
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
  /** Display name, derived from the file name (without extension). */
  name: string;
  params: ParamDef[];
  /** Tracks where this BRDF came from so IndexedDB can restore it on reload. */
  origin?:
    | { kind: 'bundled'; filename: string }
    | { kind: 'text'; name: string; content: string }
    | { kind: 'merl-online'; name: string; fileName: string; downloadUrl: string; size?: number };
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

/** A loaded BRDF together with its live UI state and current parameter values. */
export interface BrdfInstance {
  id: string;
  def: BrdfDef;
  /** Current value per parameter name (seeded from defaults). */
  values: Map<string, ParamValue>;
  /** Enabled / drawn (original "visible"). */
  visible: boolean;
}
