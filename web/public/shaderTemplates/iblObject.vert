#version 300 es
// Lit Object (IBL) vertex stage. Object is rendered in world space at the origin;
// the sphere normal is derived from position (OBJ normals can replace this later).

uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;

in vec3 vtx_position;

out vec3 wNormal;
out vec3 wPos;

void main(void)
{
    wPos = vtx_position;
    wNormal = normalize(vtx_position);
    gl_Position = projectionMatrix * viewMatrix * vec4(vtx_position, 1.0);
}
