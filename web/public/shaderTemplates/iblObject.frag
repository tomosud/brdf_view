#version 300 es
// Lit Object (IBL) shading. Two render modes:
//   renderWithIBL == 0  -> single directional light from incidentVector (No IBL)
//   renderWithIBL == 1  -> mixed Monte-Carlo over the equirect env. The sampler
//                          combines cosine hemisphere samples with two glossy
//                          lobes around the mirror direction, and evaluates with
//                          the mixture pdf: BRDF * env * cos / pdf.
// The injected analytic/measured BRDF is evaluated per sample. Importance
// sampling via env CDF textures is future work.
precision highp float;
precision highp int;

uniform sampler2D envMap;
uniform vec3 cameraPos;
uniform vec3 incidentVector;
uniform float useNDotL;
uniform float renderWithIBL;
uniform float envIntensity;
uniform int numSamples;
uniform int frameIndex;

in vec3 wNormal;
in vec3 wPos;

out vec4 fragColor;

::INSERT_UNIFORMS_HERE::

::INSERT_BRDF_FUNCTION_HERE::

const float kPI = 3.14159265358979;

vec2 dirToUV(vec3 d)
{
    float u = 0.5 + atan(d.z, d.x) / (2.0 * kPI);
    float v = 0.5 - asin(clamp(d.y, -1.0, 1.0)) / kPI;
    return vec2(u, v);
}

vec3 sampleEnv(vec3 d)
{
    return texture(envMap, dirToUV(d)).rgb * envIntensity;
}

// van der Corput radical inverse (base 2)
float radicalInverse(uint bits)
{
    bits = (bits << 16u) | (bits >> 16u);
    bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
    bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
    bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
    bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
    return float(bits) * 2.3283064365386963e-10;
}

float hash(vec2 p)
{
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void buildTBN(vec3 N, out vec3 T, out vec3 B)
{
    vec3 up = abs(N.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    T = normalize(cross(up, N));
    B = cross(N, T);
}

vec3 cosineSample(vec3 axis, float u1, float u2)
{
    vec3 T, B;
    buildTBN(axis, T, B);
    float r = sqrt(u1);
    float phi = 2.0 * kPI * u2;
    vec3 local = vec3(r * cos(phi), r * sin(phi), sqrt(max(0.0, 1.0 - u1)));
    return normalize(local.x * T + local.y * B + local.z * axis);
}

vec3 powerCosineSample(vec3 axis, float exponent, float u1, float u2)
{
    vec3 T, B;
    buildTBN(axis, T, B);
    float cosTheta = pow(max(0.0, 1.0 - u1), 1.0 / (exponent + 1.0));
    float sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
    float phi = 2.0 * kPI * u2;
    vec3 local = vec3(sinTheta * cos(phi), sinTheta * sin(phi), cosTheta);
    return normalize(local.x * T + local.y * B + local.z * axis);
}

float powerCosinePdf(float cosTheta, float exponent)
{
    if (cosTheta <= 0.0) return 0.0;
    return (exponent + 1.0) * pow(cosTheta, exponent) / (2.0 * kPI);
}

void main(void)
{
    vec3 N = normalize(wNormal);
    vec3 V = normalize(cameraPos - wPos);
    vec3 X, Y;
    buildTBN(N, X, Y);

    vec3 result = vec3(0.0);

    if (renderWithIBL > 0.5) {
        // Cranley-Patterson rotation per pixel to decorrelate the sequence.
        vec2 jitter = vec2(hash(gl_FragCoord.xy), hash(gl_FragCoord.yx + 7.0));
        int sampleOffset = frameIndex * numSamples;
        vec3 R = normalize(reflect(-V, N));
        const float mediumGlossExponent = 96.0;
        const float sharpGlossExponent = 2048.0;
        for (int i = 0; i < numSamples; i++) {
            int sampleIndex = sampleOffset + i;
            int component = sampleIndex - (sampleIndex / 3) * 3;
            int componentIndex = sampleIndex / 3;
            float u1 = fract(float(componentIndex) * 0.6180339887498949 + jitter.x);
            float u2 = fract(radicalInverse(uint(componentIndex)) + jitter.y);

            vec3 L;
            if (component == 0) {
                L = cosineSample(N, u1, u2);
            } else if (component == 1) {
                L = powerCosineSample(R, mediumGlossExponent, u1, u2);
            } else {
                L = powerCosineSample(R, sharpGlossExponent, u1, u2);
            }

            float nDotL = max(dot(N, L), 0.0);
            float cosinePdf = nDotL / kPI;
            float mediumPdf = powerCosinePdf(dot(R, L), mediumGlossExponent);
            float sharpPdf = powerCosinePdf(dot(R, L), sharpGlossExponent);
            float pdf = (cosinePdf + mediumPdf + sharpPdf) / 3.0;
            if (nDotL <= 0.0 || pdf <= 0.0) continue;

            vec3 env = sampleEnv(L);
            vec3 b = max(BRDF(L, V, N, X, Y), vec3(0.0));
            result += b * env * nDotL / pdf;
        }
        result /= float(numSamples);
    } else {
        vec3 L = normalize(incidentVector);
        vec3 b = max(BRDF(L, V, N, X, Y), vec3(0.0));
        if (useNDotL > 0.5)
            b *= max(dot(N, L), 0.0);
        result = b;
    }

    fragColor = vec4(max(result, vec3(0.0)), 1.0);
}
