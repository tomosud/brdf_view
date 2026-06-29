// Builds a BrdfDef for a measured (MERL) BRDF. The shaderSource is the original
// measured.func ported to GLSL ES 3.00: the 1D `samplerBuffer` + texelFetch(idx)
// is replaced by a 2D `sampler2D measuredData` + texelFetch(ivec2, 0), with the
// linear index unpacked via TEX_W (must match MEASURED_TEX_WIDTH in io/merl.ts).
// Integer index arithmetic is preserved, so noPromote is set.

import type { BrdfDef, BrdfInstance } from './types.js';
import { parseMerl, MEASURED_TEX_WIDTH } from '../io/merl.js';

const MEASURED_SHADER = `
uniform sampler2D measuredData;

const int BRDF_SAMPLING_RES_THETA_H = 90;
const int BRDF_SAMPLING_RES_THETA_D = 90;
const int BRDF_SAMPLING_RES_PHI_D   = 360;
const int TEX_W = ${MEASURED_TEX_WIDTH};
const float M_PI = 3.1415926535897932384626433832795;
const float RED_SCALE = (1.0/1500.0);
const float GREEN_SCALE = (1.15/1500.0);
const float BLUE_SCALE = (1.66/1500.0);

float measuredFetch(int index)
{
    ivec2 c = ivec2(index % TEX_W, index / TEX_W);
    return texelFetch(measuredData, c, 0).r;
}

int phi_diff_index(float phi_diff)
{
    if (phi_diff < 0.0)
        phi_diff += M_PI;
    return clamp(int(phi_diff * (1.0/M_PI * float(BRDF_SAMPLING_RES_PHI_D / 2))), 0, BRDF_SAMPLING_RES_PHI_D / 2 - 1);
}

int theta_half_index(float theta_half)
{
    if (theta_half <= 0.0)
        return 0;
    return clamp(int(sqrt(theta_half * (2.0/M_PI)) * float(BRDF_SAMPLING_RES_THETA_H)), 0, BRDF_SAMPLING_RES_THETA_H-1);
}

int theta_diff_index(float theta_diff)
{
    return clamp(int(theta_diff * (2.0/M_PI * float(BRDF_SAMPLING_RES_THETA_D))), 0, BRDF_SAMPLING_RES_THETA_D - 1);
}

vec3 BRDF( vec3 toLight, vec3 toViewer, vec3 normal, vec3 tangent, vec3 bitangent )
{
    vec3 H = normalize(toLight + toViewer);
    float theta_H = acos(clamp(dot(normal, H), 0.0, 1.0));
    float theta_diff = acos(clamp(dot(H, toLight), 0.0, 1.0));
    float phi_diff = 0.0;

    if (theta_diff < 1e-3) {
        phi_diff = atan(clamp(-dot(toLight, bitangent), -1.0, 1.0), clamp(dot(toLight, tangent), -1.0, 1.0));
    }
    else if (theta_H > 1e-3) {
        vec3 u = -normalize(normal - dot(normal,H) * H);
        vec3 v = cross(H, u);
        phi_diff = atan(clamp(dot(toLight,v), -1.0, 1.0), clamp(dot(toLight,u), -1.0, 1.0));
    }
    else theta_H = 0.0;

    int ind = phi_diff_index(phi_diff) +
        theta_diff_index(theta_diff) * BRDF_SAMPLING_RES_PHI_D / 2 +
        theta_half_index(theta_H) * BRDF_SAMPLING_RES_PHI_D / 2 *
        BRDF_SAMPLING_RES_THETA_D;

    int redIndex = ind;
    int greenIndex = ind + BRDF_SAMPLING_RES_THETA_H*BRDF_SAMPLING_RES_THETA_D*BRDF_SAMPLING_RES_PHI_D/2;
    int blueIndex = ind + BRDF_SAMPLING_RES_THETA_H*BRDF_SAMPLING_RES_THETA_D*BRDF_SAMPLING_RES_PHI_D;

    return vec3(
        measuredFetch(redIndex)   * RED_SCALE,
        measuredFetch(greenIndex) * GREEN_SCALE,
        measuredFetch(blueIndex)  * BLUE_SCALE
    );
}
`;

let counter = 0;

export function measuredBrdfFromBuffer(name: string, buf: ArrayBuffer): BrdfInstance {
  const measured = parseMerl(buf);
  const def: BrdfDef = {
    name,
    params: [],
    shaderSource: MEASURED_SHADER,
    isFuncSource: null,
    noPromote: true,
    measured,
  };
  return { id: `merl-${counter++}`, def, values: new Map(), visible: true };
}
