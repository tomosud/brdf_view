#version 300 es
// Lit Object (IBL) shading. Two render modes:
//   renderWithIBL == 0  -> single directional light from incidentVector (No IBL)
//   renderWithIBL == 1  -> cosine-weighted Monte-Carlo over the equirect env
//                          (estimator: BRDF * env * cos / pdf, pdf = cos/kPI).
// The injected analytic/measured BRDF is evaluated per sample. Importance
// sampling (IBL IS / BRDF IS / MIS) via env CDF textures is future work.
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
        for (int i = 0; i < numSamples; i++) {
            int sampleIndex = sampleOffset + i;
            float u1 = fract(float(sampleIndex) * 0.6180339887498949 + jitter.x);
            float u2 = fract(radicalInverse(uint(sampleIndex)) + jitter.y);
            // cosine-weighted hemisphere sample (local space, +Z = normal)
            float r = sqrt(u1);
            float phi = 2.0 * kPI * u2;
            vec3 local = vec3(r * cos(phi), r * sin(phi), sqrt(max(0.0, 1.0 - u1)));
            vec3 L = normalize(local.x * X + local.y * Y + local.z * N);
            vec3 env = sampleEnv(L);
            vec3 b = max(BRDF(L, V, N, X, Y), vec3(0.0));
            // estimator: BRDF * env * cos / (cos/kPI) = BRDF * env * kPI
            result += b * env * kPI;
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
