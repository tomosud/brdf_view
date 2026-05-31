#version 300 es
// Solid plot color (matches brdftemplate2D.frag).
precision highp float;
uniform vec3 drawColor;
out vec4 fragColor;
void main(void) { fragColor = vec4(drawColor, 1.0); }
