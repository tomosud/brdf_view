#version 300 es
// Ported to GLSL ES 3.00 from brdftemplatesphere.vert.
// Copyright Disney Enterprises, Inc. All rights reserved. See public/LICENSE.

uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;

in vec3 vtx_position;

out vec4 worldSpaceVert;
out vec4 eyeSpaceVert;

void main(void)
{
    worldSpaceVert = vec4(vtx_position,1);
    eyeSpaceVert = modelViewMatrix * worldSpaceVert;
    gl_Position = projectionMatrix * eyeSpaceVert;
}
