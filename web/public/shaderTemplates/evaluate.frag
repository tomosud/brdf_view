#version 300 es
// Numeric BRDF evaluation for window.brdfView.evaluate / exportData (not a
// display view). One output texel per sample: the raw BRDF(L, V, N, X, Y) RGB,
// with no clamping, N.L, exposure or log mapping. Inputs are packed in
// evalInput as 5 row blocks of evalRows rows each: L, V, N, X, Y.
//
// With BRDF_SSS defined (a .brdf that declares the pseudo-SSS hooks, see
// src/gl/sss.ts) evalComponent selects 1 = BRDF_sss_diffuse, 2 = BRDF_sss_albedo.

precision highp float;
precision highp int;
precision highp sampler2D;

::INSERT_DEFINES_HERE::

uniform sampler2D evalInput;
uniform int evalRows;
uniform int evalComponent;

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
    vec3 value = BRDF(L, V, N, X, Y);
#ifdef BRDF_SSS
    if (evalComponent == 1) value = BRDF_sss_diffuse(L, V, N, X, Y);
#ifdef BRDF_SSS_HAS_ALBEDO
    if (evalComponent == 2) value = BRDF_sss_albedo();
#else
    if (evalComponent == 2) value = vec3(1.0);
#endif
#endif
    fragColor = vec4(value, 1.0);
}
