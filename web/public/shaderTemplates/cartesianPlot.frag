#version 300 es
precision highp float;
uniform vec3 drawColor;
in float v_curveAlpha;
out vec4 fragColor;
void main(void) { fragColor = vec4(drawColor, v_curveAlpha); }
