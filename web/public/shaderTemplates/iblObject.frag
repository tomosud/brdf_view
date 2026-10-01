#version 300 es
// Lit Object (IBL) shading. Two render modes:
//   renderWithIBL == 0  -> single directional light from incidentVector (No IBL)
//   renderWithIBL == 1  -> mixed Monte-Carlo over the equirect env. The sampler
//                          combines cosine hemisphere samples, two glossy lobes
//                          around the mirror direction, and environment-map
//                          luminance sampling. It evaluates with the mixture pdf:
//                          BRDF * env * cos / pdf.
//                          Self-occlusion (occlusionMode): 1 weights each sample
//                          by the baked per-vertex visibility V(L) (SH), 2 traces
//                          a shadow ray against the mesh BVH (any hit).
// The injected analytic/measured BRDF is evaluated per sample.
//
// Pseudo SSS variant (BRDF_SSS defined by src/gl/sss.ts when the .brdf declares
// BRDF_sss_diffuse): the lighting is split over three outputs so that only the
// diffuse light is blurred afterwards. Without the define this shader is the
// plain single-output one.
precision highp float;
precision highp int;

::INSERT_DEFINES_HERE::

uniform sampler2D envMap;
uniform sampler2D envConditionalCdf;
uniform sampler2D envMarginalCdf;
uniform vec3 cameraPos;
uniform vec3 incidentVector;
uniform float useNDotL;
uniform float renderWithIBL;
uniform float envIntensity;
uniform float grayscaleIBL;
uniform float envTotalWeight;
uniform int numSamples;
uniform int frameIndex;
// Tangent-space normal map (OpenGL convention; normalFlipY = -1 for DirectX maps).
uniform sampler2D normalMap;
uniform float useNormalMap;
uniform float normalFlipY;
uniform float normalStrength;
// 0 off, 1 baked SH (vOcc*), 2 ray traced against the BVH (bvhNodes / bvhTris).
uniform int occlusionMode;
// BVH packed by src/gl/bvh.ts (RGBA32F, 2048 texels per row).
uniform highp sampler2D bvhNodes;
uniform highp sampler2D bvhTris;
// Shadow-ray origin offset along the geometric normal (scaled to the mesh).
uniform float rayEpsilon;

in vec3 wNormal;
in vec3 wPos;
in vec2 vUV; // mesh texture coordinates (parameter images, normal map)
in vec4 wTangent;
// Occlusion SH coefficients (l <= 3), baked by src/gl/visibility-bake.ts.
in vec4 vOcc0;
in vec4 vOcc1;
in vec4 vOcc2;
in vec4 vOcc3;

#ifdef BRDF_SSS
// Camera forward axis, for the view depth stored next to the diffuse light.
uniform vec3 sssCamForward;
layout(location = 0) out vec4 fragColor;      // specular (not scattered); a: coverage
layout(location = 1) out vec4 fragSssDiffuse; // diffuse light before albedo; a: view depth
layout(location = 2) out vec4 fragSssAlbedo;  // albedo applied after scattering
#else
out vec4 fragColor;
#endif

::INSERT_UNIFORMS_HERE::

::INSERT_BRDF_FUNCTION_HERE::

const float kPI = 3.14159265358979;

vec2 dirToUV(vec3 d)
{
    float u = 0.5 + atan(d.z, d.x) / (2.0 * kPI);
    float v = 0.5 - asin(clamp(d.y, -1.0, 1.0)) / kPI;
    return vec2(u, v);
}

vec3 uvToDir(vec2 uv)
{
    float phi = (uv.x - 0.5) * (2.0 * kPI);
    float y = sin((0.5 - uv.y) * kPI);
    float r = sqrt(max(0.0, 1.0 - y * y));
    return vec3(cos(phi) * r, y, sin(phi) * r);
}

vec3 sampleEnv(vec3 d)
{
    vec3 c = texture(envMap, dirToUV(d)).rgb;
    if (grayscaleIBL > 0.5) {
        c = vec3(dot(c, vec3(0.2126, 0.7152, 0.0722)));
    }
    return c * envIntensity;
}

int lowerBound1D(sampler2D cdfTex, int x, int n, float u)
{
    int lo = 0;
    int hi = n - 1;
    for (int i = 0; i < 20; i++) {
        if (lo >= hi) break;
        int mid = (lo + hi) / 2;
        float cdf = texelFetch(cdfTex, ivec2(x, mid), 0).r;
        if (cdf < u) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

int lowerBoundRow(sampler2D cdfTex, int y, int n, float u)
{
    int lo = 0;
    int hi = n - 1;
    for (int i = 0; i < 20; i++) {
        if (lo >= hi) break;
        int mid = (lo + hi) / 2;
        float cdf = texelFetch(cdfTex, ivec2(mid, y), 0).r;
        if (cdf < u) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

vec3 envImportanceSample(float u1, float u2)
{
    ivec2 sz = textureSize(envConditionalCdf, 0);
    int y = lowerBound1D(envMarginalCdf, 0, sz.y, u1);
    int x = lowerBoundRow(envConditionalCdf, y, sz.x, u2);
    vec2 uv = (vec2(float(x), float(y)) + vec2(0.5)) / vec2(sz);
    return uvToDir(uv);
}

float envImportancePdf(vec3 d)
{
    if (envTotalWeight <= 0.0) return 0.0;
    ivec2 sz = textureSize(envMap, 0);
    vec2 uv = dirToUV(d);
    int x = clamp(int(floor(fract(uv.x) * float(sz.x))), 0, sz.x - 1);
    int y = clamp(int(floor(clamp(uv.y, 0.0, 0.999999) * float(sz.y))), 0, sz.y - 1);
    vec3 c = texelFetch(envMap, ivec2(x, y), 0).rgb;
    float luminance = max(dot(max(c, vec3(0.0)), vec3(0.2126, 0.7152, 0.0722)), 0.0);
    return luminance * float(sz.x * sz.y) / (envTotalWeight * 2.0 * kPI * kPI);
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

// Blocked fraction toward d from the baked occlusion SH. The real SH basis
// must match ACCUM_FRAG in src/gl/visibility-bake.ts.
float occlusionSH(vec3 d)
{
    float x = d.x, y = d.y, z = d.z;
    float o = dot(vOcc0, vec4(0.282095, 0.488603 * y, 0.488603 * z, 0.488603 * x));
    o += dot(vOcc1, vec4(1.092548 * x * y, 1.092548 * y * z, 0.315392 * (3.0 * z * z - 1.0), 1.092548 * x * z));
    o += dot(vOcc2, vec4(0.546274 * (x * x - y * y), 0.590044 * y * (3.0 * x * x - y * y), 2.890611 * x * y * z, 0.457046 * y * (5.0 * z * z - 1.0)));
    o += dot(vOcc3, vec4(0.373176 * z * (5.0 * z * z - 3.0), 0.457046 * x * (5.0 * z * z - 1.0), 1.445306 * z * (x * x - y * y), 0.590044 * x * (x * x - 3.0 * y * y)));
    return clamp(o, 0.0, 1.0);
}

// --- ray-traced occlusion (BVH layout: see src/gl/bvh.ts) ---
const int BVH_STACK_SIZE = 48; // BVH_MAX_DEPTH in src/gl/bvh.ts
const int BVH_MAX_STEPS = 4096; // safety cap; an unfinished ray counts as visible

ivec2 bvhTexel(int i)
{
    return ivec2(i & 2047, i >> 11); // BVH_TEXTURE_WIDTH = 2048
}

// Moller-Trumbore, front faces only (triangles are wound along the vertex normals).
bool rayHitsTriangle(int tri, vec3 o, vec3 d)
{
    vec3 v0 = texelFetch(bvhTris, bvhTexel(3 * tri), 0).xyz;
    vec3 e1 = texelFetch(bvhTris, bvhTexel(3 * tri + 1), 0).xyz;
    vec3 e2 = texelFetch(bvhTris, bvhTexel(3 * tri + 2), 0).xyz;
    vec3 p = cross(d, e2);
    float det = dot(e1, p);
    if (det <= 0.0) return false;
    vec3 s = o - v0;
    float u = dot(s, p);
    if (u < 0.0 || u > det) return false;
    vec3 q = cross(s, e1);
    float v = dot(d, q);
    if (v < 0.0 || u + v > det) return false;
    return dot(e2, q) > 0.0;
}

// Any-hit traversal: true as soon as the ray from o along d hits a front face.
bool occludedRay(vec3 o, vec3 d)
{
    vec3 dirSign = mix(vec3(-1.0), vec3(1.0), step(0.0, d));
    vec3 invD = 1.0 / (dirSign * max(abs(d), vec3(1e-12)));
    int stack[BVH_STACK_SIZE];
    int sp = 0;
    int node = 0;
    for (int iter = 0; iter < BVH_MAX_STEPS; iter++) {
        vec4 lo = texelFetch(bvhNodes, bvhTexel(2 * node), 0);
        vec4 hi = texelFetch(bvhNodes, bvhTexel(2 * node + 1), 0);
        vec3 t0 = (lo.xyz - o) * invD;
        vec3 t1 = (hi.xyz - o) * invD;
        vec3 tn = min(t0, t1);
        vec3 tf = max(t0, t1);
        float tNear = max(max(tn.x, tn.y), max(tn.z, 0.0));
        float tFar = min(min(tf.x, tf.y), tf.z);
        if (tNear <= tFar) {
            int count = int(hi.w);
            if (count == 0) {
                // internal: visit the left child (node + 1) now, the right one later
                if (sp < BVH_STACK_SIZE) {
                    stack[sp] = int(lo.w);
                    sp++;
                }
                node++;
                continue;
            }
            int first = int(lo.w);
            for (int k = 0; k < count; k++) {
                if (rayHitsTriangle(first + k, o, d)) return true;
            }
        }
        if (sp == 0) return false;
        sp--;
        node = stack[sp];
    }
    return false;
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
    // Parameters with an attached image are read per pixel here.
    ::INSERT_TEXTURE_FETCH_HERE::

    vec3 N = normalize(wNormal);
    // Geometric (flat) normal of this triangle, on the side of the vertex normal.
    // Shadow rays start just off this plane: above it for rays leaving the
    // surface, just below it for rays the smooth normal allows but the facet
    // does not (they then only meet back faces of a convex neighbourhood, which
    // the any-hit test ignores; this avoids the shadow-terminator artefact).
    vec3 Ng = cross(dFdx(wPos), dFdy(wPos));
    Ng = dot(Ng, Ng) > 0.0 ? normalize(Ng) : N;
    if (dot(Ng, N) < 0.0) Ng = -Ng;
    if (useNormalMap > 0.5) {
        vec3 T = wTangent.xyz - N * dot(N, wTangent.xyz);
        if (dot(T, T) > 1e-12) {
            T = normalize(T);
            vec3 B = cross(N, T) * (wTangent.w < 0.0 ? -1.0 : 1.0);
            vec3 nm = texture(normalMap, vUV).xyz * 2.0 - 1.0;
            nm.y *= normalFlipY;
            nm.xy *= normalStrength;
            N = normalize(T * nm.x + B * nm.y + N * max(nm.z, 1e-4));
        }
    }
    vec3 V = normalize(cameraPos - wPos);
    vec3 X, Y;
    buildTBN(N, X, Y);

    vec3 result = vec3(0.0);
#ifdef BRDF_SSS
    // result holds the specular part; the diffuse part (before albedo) goes to sssDiffuse.
    vec3 sssDiffuse = vec3(0.0);
#ifdef BRDF_SSS_HAS_ALBEDO
    vec3 sssAlbedo = max(BRDF_sss_albedo(), vec3(0.0));
#else
    vec3 sssAlbedo = vec3(1.0);
#endif
#endif

    if (renderWithIBL > 0.5) {
        // Cranley-Patterson rotation per pixel to decorrelate the sequence.
        vec2 jitter = vec2(hash(gl_FragCoord.xy), hash(gl_FragCoord.yx + 7.0));
        int sampleOffset = frameIndex * numSamples;
        vec3 R = normalize(reflect(-V, N));
        const float mediumGlossExponent = 96.0;
        const float sharpGlossExponent = 2048.0;
        for (int i = 0; i < numSamples; i++) {
            int sampleIndex = sampleOffset + i;
            int component = sampleIndex - (sampleIndex / 4) * 4;
            int componentIndex = sampleIndex / 4;
            float u1 = fract(float(componentIndex) * 0.6180339887498949 + jitter.x);
            float u2 = fract(radicalInverse(uint(componentIndex)) + jitter.y);

            vec3 L;
            if (component == 0) {
                L = cosineSample(N, u1, u2);
            } else if (component == 1) {
                L = powerCosineSample(R, mediumGlossExponent, u1, u2);
            } else if (component == 2) {
                L = powerCosineSample(R, sharpGlossExponent, u1, u2);
            } else {
                L = envImportanceSample(u1, u2);
            }

            float nDotL = max(dot(N, L), 0.0);
            float cosinePdf = nDotL / kPI;
            float mediumPdf = powerCosinePdf(dot(R, L), mediumGlossExponent);
            float sharpPdf = powerCosinePdf(dot(R, L), sharpGlossExponent);
            float envPdf = envImportancePdf(L);
            float pdf = (cosinePdf + mediumPdf + sharpPdf + envPdf) / 4.0;
            if (nDotL <= 0.0 || pdf <= 0.0) continue;

            float visibility = occlusionMode == 1 ? 1.0 - occlusionSH(L) : 1.0;
            if (visibility <= 0.0) continue;

            vec3 env = sampleEnv(L);
            vec3 b = max(BRDF(L, V, N, X, Y), vec3(0.0));
            vec3 contribution = b * env * nDotL * visibility / pdf;
            // Ray: trace only samples that would add light.
            if (occlusionMode == 2 && max(contribution.r, max(contribution.g, contribution.b)) > 0.0) {
                vec3 origin = wPos + Ng * (dot(Ng, L) >= 0.0 ? rayEpsilon : -rayEpsilon);
                if (occludedRay(origin, L)) continue;
            }
#ifdef BRDF_SSS
            vec3 d = max(BRDF_sss_diffuse(L, V, N, X, Y), vec3(0.0)) * env * nDotL * visibility / pdf;
            sssDiffuse += d;
            result += max(contribution - d * sssAlbedo, vec3(0.0));
#else
            result += contribution;
#endif
        }
        result /= float(numSamples);
#ifdef BRDF_SSS
        sssDiffuse /= float(numSamples);
#endif
    } else {
        vec3 L = normalize(incidentVector);
        vec3 b = max(BRDF(L, V, N, X, Y), vec3(0.0));
        float lightScale = useNDotL > 0.5 ? max(dot(N, L), 0.0) : 1.0;
#ifdef BRDF_SSS
        vec3 d = max(BRDF_sss_diffuse(L, V, N, X, Y), vec3(0.0));
        sssDiffuse = d * lightScale;
        result = max(b - d * sssAlbedo, vec3(0.0)) * lightScale;
#else
        result = b * lightScale;
#endif
    }

    fragColor = vec4(max(result, vec3(0.0)), 1.0);
#ifdef BRDF_SSS
    fragSssDiffuse = vec4(max(sssDiffuse, vec3(0.0)), dot(wPos - cameraPos, sssCamForward));
    fragSssAlbedo = vec4(sssAlbedo, 1.0);
#endif
}
