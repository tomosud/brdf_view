#version 300 es
// Cartesian angle plots. Reimplements Disney's Theta V / Theta H / Theta D
// angle templates, the Albedo angle template, and the miter geometry shader.
// x is the selected angle in [-pi/2, pi/2], y is BRDF/albedo value.
// modelViewMatrix carries the per-axis scale.
// Copyright Disney Enterprises, Inc. (original templates). See public/LICENSE.

precision highp float;
precision highp int;

uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform vec3 incidentVector;
uniform float incidentPhi;
uniform float useLogPlot;
uniform float useNDotL;
uniform float phiV;
uniform float angleParam;
uniform int plotMode; // 0: thetaV, 1: thetaH, 2: thetaD, 3: albedo
uniform int segmentCount;
uniform int nSamples;
uniform float sampleMultOn;
uniform int samplingMode;
uniform vec3 colorMask;
uniform vec2 viewport_size;
uniform float thickness;

out float v_curveAlpha;

::INSERT_UNIFORMS_HERE::

::INSERT_BRDF_FUNCTION_HERE::

::INSERT_MITER_HERE::

const int SEGMENTS = 512;
const float TMIN = -1.57079633;
const float TMAX = 1.57079633;
const float PI_ = 3.14159265358979323846264;
const vec3 RGB2L = vec3(0.3, 0.59, 0.11);

struct CurveSample {
    vec2 pos;
    float alpha;
};

float modifyLog( float x ) { return log(max(x, 0.0) + 1.0) * 0.434294482; }

vec3 rotateVector(vec3 v, vec3 axis, float angle)
{
    axis = normalize(axis);
    vec3 n = axis * dot(axis, v);
    return n + cos(angle) * (v - n) + sin(angle) * cross(axis, v);
}

float hammersleySample(uint bits)
{
    bits = (bits << 16u) | (bits >> 16u);
    bits = ((bits & 0x00ff00ffu) << 8u) | ((bits & 0xff00ff00u) >> 8u);
    bits = ((bits & 0x0f0f0f0fu) << 4u) | ((bits & 0xf0f0f0fu) >> 4u);
    bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xccccccccu) >> 2u);
    bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xaaaaaaaau) >> 1u);
    return float(bits) * 2.3283064365386963e-10;
}

float cosinePdf(vec3 incident, vec3 view)
{
    if (view.z < 0.0) return 0.0;
    return view.z / PI_;
}

float cosineSample(float x1, vec3 incident, inout vec3 view)
{
    float r = sqrt(x1);
    float costhetaV = sqrt(max(0.0, 1.0 - r * r));
    view = normalize(vec3(r * view.x, r * view.y, costhetaV));
    return PI_;
}

float uniformSample(float x1, vec3 incident, inout vec3 view)
{
    float costhetaV = x1;
    float sinthetaV = sqrt(max(0.0, 1.0 - costhetaV * costhetaV));
    view = normalize(vec3(costhetaV * view.x, costhetaV * view.y, sinthetaV));
    return 2.0 * PI_ * costhetaV;
}

float polarSample(float x1, vec3 incident, inout vec3 view)
{
    float costhetaV = cos(x1 * 0.5 * PI_);
    float sinthetaV = sin(x1 * 0.5 * PI_);
    view = normalize(vec3(sinthetaV * view.x, sinthetaV * view.y, costhetaV));
    return PI_ * PI_ * costhetaV * sinthetaV;
}

float blinnPdf(float exponent, vec3 incident, vec3 view)
{
    vec3 H = normalize(incident + view);
    float costhetah = H.z;
    float costhetad = dot(view, H);
    if (costhetad < 0.0) return 0.0;
    return (exponent + 1.0) * pow(costhetah, exponent) / (PI_ * 8.0 * costhetad);
}

float blinnSample(float exponent, float x1, vec3 incident, inout vec3 view)
{
    float costhetah = pow(x1, 1.0 / (exponent + 1.0));
    float sinthetah = sqrt(max(0.0, 1.0 - costhetah * costhetah));
    vec3 halfvector = vec3(sinthetah * view.x, sinthetah * view.y, costhetah);
    if (halfvector.z * incident.z < 0.0) halfvector = -halfvector;
    view = -incident + 2.0 * dot(incident, halfvector) * halfvector;
    if (view.z < 0.0) return 0.0;
    float pdfinv = PI_ * 8.0 * dot(incident, halfvector) / ((exponent + 1.0) * pow(costhetah, exponent));
    return view.z * pdfinv;
}

float misPowerHeuristic(int nF, float pdfF, int nG, float pdfG)
{
    float f = float(nF) * pdfF;
    float g = float(nG) * pdfG;
    return (f * f) / max(f * f + g * g, 1.0e-12);
}

float estimateBlinnExponent(vec3 N, vec3 X, vec3 Y)
{
    float cosphi = cos(incidentPhi);
    float sinphi = sin(incidentPhi);
    float theta = 0.25 * PI_;
    float deltaTheta = 0.5 * theta;
    float maxBrdfVal = dot(RGB2L, BRDF(N, N, N, X, Y));
    float minBrdfVal = dot(RGB2L, BRDF(N, vec3(0.985 * cosphi, 0.985 * sinphi, 0.1697), N, X, Y));
    float target = 0.05 * maxBrdfVal + minBrdfVal;
    float brdfVal = dot(RGB2L, BRDF(N, vec3(sin(theta) * cosphi, sin(theta) * sinphi, cos(theta)), N, X, Y));

    for (int step = 0; step < 16; step++) {
        if (!(deltaTheta > 0.01 && abs(target - brdfVal) > 0.01 * target && theta < 0.5 * PI_)) break;
        if (brdfVal < target) theta -= deltaTheta;
        else theta += deltaTheta;
        deltaTheta *= 0.5;
        float costhetah = cos(theta);
        float sinthetah = sin(theta);
        brdfVal = dot(RGB2L, BRDF(N, normalize(vec3(sinthetah * cosphi, sinthetah * sinphi, costhetah)), N, X, Y));
    }

    float exponent = max(2.0, min(1000.0, log(max(brdfVal, 1.0e-8)) / log(max(cos(theta / 2.0), 1.0e-8))));
    if (theta < 0.2) exponent = 1000.0;
    if ((maxBrdfVal - minBrdfVal) / max(minBrdfVal, 1.0e-8) < 1.5) exponent = 2.0;
    return exponent * 2.0;
}

CurveSample albedoPoint(float t, vec3 N, vec3 X, vec3 Y)
{
    vec3 L = normalize(vec3(sin(t) * cos(incidentPhi), sin(t) * sin(incidentPhi), cos(t)));
    float exponent = (samplingMode == 3 || samplingMode == 4) ? estimateBlinnExponent(N, X, Y) : 2.0;

    int ns = nSamples;
    if (sampleMultOn > 0.5) ns *= 10;
    ns = clamp(ns, 1, 100000);
    float nsInv = 1.0 / float(ns);
    vec3 radianceFull = vec3(0.0);
    vec3 radiance23 = vec3(0.0);

    for (int i = 0; i < ns; i++) {
        float phiVLocal = 2.0 * PI_ * float(i) * nsInv;
        float x1 = hammersleySample(uint(i));
        vec3 V = vec3(cos(phiVLocal), sin(phiVLocal), 1.0);
        float costhetaOverPdf = 0.0;
        if (samplingMode == 0 || samplingMode == 4) costhetaOverPdf = cosineSample(x1, L, V);
        else if (samplingMode == 1) costhetaOverPdf = uniformSample(x1, L, V);
        else if (samplingMode == 2) costhetaOverPdf = polarSample(x1, L, V);
        else if (samplingMode == 3) costhetaOverPdf = blinnSample(exponent, x1, L, V);

        if (costhetaOverPdf > 0.0) {
            vec3 radiance = BRDF(L, V, N, X, Y) * costhetaOverPdf;
            if (samplingMode == 4) {
                radiance *= misPowerHeuristic(ns, cosinePdf(L, V), ns, blinnPdf(exponent, L, V));
            }
            radianceFull += radiance;
            if ((i % 3) != 0) radiance23 += radiance;
        }

        if (samplingMode == 4) {
            V = vec3(cos(phiVLocal), sin(phiVLocal), 1.0);
            float blinnCosthetaOverPdf = blinnSample(exponent, x1, L, V);
            if (blinnCosthetaOverPdf > 0.0) {
                vec3 radianceG = BRDF(L, V, N, X, Y) * blinnCosthetaOverPdf;
                radianceG *= misPowerHeuristic(ns, V.z / blinnCosthetaOverPdf, ns, cosinePdf(L, V));
                radianceFull += radianceG;
                if ((i % 3) != 0) radiance23 += radianceG;
            }
        }
    }

    vec3 bRes = nsInv * radianceFull;
    vec3 bRes23 = nsInv * radiance23 * 1.5;
    float bResL = dot(bRes, RGB2L);
    float bRes23L = dot(bRes23, RGB2L);
    float error = abs(bResL - bRes23L) / max(bResL, 1.0e-8);
    float alpha = 1.0;
    if (error > 0.05) alpha = 0.05;
    if (error > 0.02) alpha = 0.15;
    int degrees = int(round(180.0 * t / PI_));
    if ((degrees % 15) == 0) alpha = 1.0;

    float b = dot(bRes, colorMask);
    b = max(b, 0.0);
    float radius = useLogPlot > 0.5 ? modifyLog(b) : b;
    return CurveSample(vec2(t, radius), alpha);
}

// model-space curve point (theta, brdfValue) at sample idx (0..segmentCount)
CurveSample curvePoint(int idx)
{
    int count = max(segmentCount, 1);
    float t = TMIN + (TMAX - TMIN) * float(idx) / float(count);

    vec3 N = vec3(0,0,1);
    vec3 X = vec3(1,0,0);
    vec3 Y = vec3(0,1,0);

    if (plotMode == 3) return albedoPoint(t, N, X, Y);

    vec3 nIV = normalize(incidentVector);
    vec3 L = nIV;
    vec3 V;

    if (plotMode == 1) {
        float thetaH = t;
        float thetaD = angleParam;
        L = rotateVector(rotateVector(N, X, thetaD), Y, thetaH);
        vec3 H = rotateVector(N, Y, thetaH);
        V = 2.0 * dot(L, H) * H - L;
    } else if (plotMode == 2) {
        float thetaD = t;
        float thetaH = angleParam;
        L = rotateVector(rotateVector(N, X, thetaD), Y, thetaH);
        vec3 H = rotateVector(N, Y, thetaH);
        V = 2.0 * dot(L, H) * H - L;
    } else {
        float yAngle = -t;
        V = normalize( vec3( sin(yAngle) * cos(phiV),
                             sin(yAngle) * sin(phiV),
                             cos(yAngle) ) );
    }

    vec3 bRes = BRDF( L, V, N, X, Y );
    float b = dot( bRes, colorMask );
    b *= (useNDotL > 0.5 ? max(dot( N, L ), 0.0) : 1.0);
    b = max(b, 0.0);
    float radius = useLogPlot > 0.5 ? modifyLog( b ) : b;
    return CurveSample(vec2(t, radius), 1.0);
}

vec2 toScreen(vec2 p)
{
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);
    return (clip.xy / clip.w) * viewport_size;
}

void main(void)
{
    int seg = gl_VertexID / 6;
    int corner = gl_VertexID % 6;
    int count = max(segmentCount, 1);

    CurveSample prevSample = curvePoint(max(seg - 1, 0));
    CurveSample startSample = curvePoint(seg);
    CurveSample endSample = curvePoint(seg + 1);
    CurveSample nextSample = curvePoint(min(seg + 2, count));

    vec2 prev  = toScreen(prevSample.pos);
    vec2 start = toScreen(startSample.pos);
    vec2 end   = toScreen(endSample.pos);
    vec2 next  = toScreen(nextSample.pos);

    int order = CORNER_ORDER[corner];
    v_curveAlpha = order < 2 ? startSample.alpha : endSample.alpha;
    vec2 p = miterCorner(order, prev, start, end, next, thickness, seg == 0, seg == count - 1);
    gl_Position = vec4(p / viewport_size, 0.0, 1.0);
}
