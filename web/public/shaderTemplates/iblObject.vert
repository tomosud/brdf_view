#version 300 es
// Lit Object (IBL) vertex stage. Object is rendered in world space at the origin;
// the sphere normal is derived from position (OBJ normals can replace this later).

uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;

in vec3 vtx_position;
in vec3 vtx_normal;
in vec2 vtx_uv;
in vec4 vtx_tangent;
// Self-occlusion SH (16 coefficients, see src/gl/visibility-bake.ts).
in vec4 vtx_occ0;
in vec4 vtx_occ1;
in vec4 vtx_occ2;
in vec4 vtx_occ3;

out vec3 wNormal;
out vec3 wPos;
out vec2 vUV;
out vec4 wTangent;
out vec4 vOcc0;
out vec4 vOcc1;
out vec4 vOcc2;
out vec4 vOcc3;

void main(void)
{
    wPos = vtx_position;
    wNormal = normalize(vtx_normal);
    vUV = vtx_uv;
    wTangent = vtx_tangent;
    vOcc0 = vtx_occ0;
    vOcc1 = vtx_occ1;
    vOcc2 = vtx_occ2;
    vOcc3 = vtx_occ3;
    gl_Position = projectionMatrix * viewMatrix * vec4(vtx_position, 1.0);
}
