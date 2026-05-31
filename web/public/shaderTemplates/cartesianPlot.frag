#version 300 es
precision highp float;
uniform vec3 drawColor;
out vec4 fragColor;
void main(void) { fragColor = vec4(drawColor, 1.0); }
