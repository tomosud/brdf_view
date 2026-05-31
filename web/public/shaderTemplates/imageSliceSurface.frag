#version 300 es
precision highp float;

uniform float gamma;
uniform float showChroma;
uniform float useLogPlot;

in vec3 hdrColor;
in float heightValue;

out vec4 fragColor;

void main()
{
    vec3 b = hdrColor;
    if (showChroma != 0.0) {
        float nrm = max(b.r, max(b.g, b.b));
        if (nrm > 0.0) b /= nrm;
    }
    if (useLogPlot != 0.0) {
        float luma = dot(b, vec3(0.3, 0.59, 0.11));
        float mapped = log(max(luma, 0.0) + 1.0);
        b *= luma > 0.0 ? mapped / luma : 0.0;
    }
    b = pow(max(b, vec3(0.0)), vec3(1.0 / gamma));
    float shade = 0.65 + 0.35 * clamp(heightValue * 0.8 + 0.2, 0.0, 1.0);
    fragColor = vec4(clamp(b * shade, 0.0, 1.0), 1.0);
}
