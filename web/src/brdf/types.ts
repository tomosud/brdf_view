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

/** A parsed .brdf file: parameter declarations + raw GLSL fragments (preserved verbatim). */
export interface BrdfDef {
  /** Display name, derived from the file name (without extension). */
  name: string;
  params: ParamDef[];
  /** Raw GLSL body that defines `vec3 BRDF(vec3 L, vec3 V, vec3 N, vec3 X, vec3 Y)`. */
  shaderSource: string;
  /** Raw GLSL importance-sampling fragment (IBL); preserved but unused in this milestone. */
  isFuncSource: string | null;
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
