#version 300 es
// Numeric BRDF evaluation for window.brdfView.evaluate / exportData (not a
// display view). One output texel per sample: the raw BRDF(L, V, N, X, Y) RGB,
// with no clamping, N.L, exposure or log mapping. Inputs are packed in
// evalInput as 5 row blocks of evalRows rows each: L, V, N, X, Y.

precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D evalInput;
uniform int evalRows;

out vec4 fragColor;

::INSERT_UNIFORMS_HERE::

::INSERT_BRDF_FUNCTION_HERE::

void main()
{
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec3 L = texelFetch(evalInput, ivec2(p.x, p.y), 0).xyz;
    vec3 V = texelFetch(evalInput, ivec2(p.x, p.y + evalRows), 0).xyz;
    vec3 N = texelFetch(evalInput, ivec2(p.x, p.y + 2 * evalRows), 0).xyz;
    vec3 X = texelFetch(evalInput, ivec2(p.x, p.y + 3 * evalRows), 0).xyz;
    vec3 Y = texelFetch(evalInput, ivec2(p.x, p.y + 4 * evalRows), 0).xyz;
    fragColor = vec4(BRDF(L, V, N, X, Y), 1.0);
}
