#version 300 es
// Equirect environment background. Reconstructs the camera ray from precomputed
// basis vectors (camRight/camUp already scaled by tan(fovy/2) and aspect).
precision highp float;

uniform sampler2D envMap;
uniform vec3 camForward;
uniform vec3 camRight;
uniform vec3 camUp;
uniform float envIntensity;
uniform float hideBackground;
uniform float grayscaleIBL;

in vec2 v_ndc;
out vec4 fragColor;

const float PI = 3.14159265358979;

vec2 dirToUV(vec3 d)
{
    float u = 0.5 + atan(d.z, d.x) / (2.0 * PI);
    float v = 0.5 - asin(clamp(d.y, -1.0, 1.0)) / PI;
    return vec2(u, v);
}

void main(void)
{
    vec3 dir = normalize(camForward + v_ndc.x * camRight + v_ndc.y * camUp);
    vec3 c = hideBackground > 0.5 ? vec3(0.21763764) : texture(envMap, dirToUV(dir)).rgb * envIntensity;
    if (grayscaleIBL > 0.5) {
        c = vec3(dot(c, vec3(0.2126, 0.7152, 0.0722)));
    }
    fragColor = vec4(max(c, vec3(0.0)), 1.0);
}
