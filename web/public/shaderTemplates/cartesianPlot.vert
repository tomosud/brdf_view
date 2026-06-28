#version 300 es
// Cartesian angle plots. Reimplements Disney's Theta V / Theta H / Theta D
// angle templates and the miter geometry shader.
// x is the selected angle in [-pi/2, pi/2], y is BRDF value.
// modelViewMatrix carries the per-axis scale.
// Copyright Disney Enterprises, Inc. (original templates). See public/LICENSE.

precision highp float;
precision highp int;

uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform vec3 incidentVector;
uniform float useLogPlot;
uniform float useNDotL;
uniform float phiV;
uniform float angleParam;
uniform int plotMode; // 0: thetaV, 1: thetaH, 2: thetaD
uniform int segmentCount;
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

// model-space curve point (theta, brdfValue) at sample idx (0..segmentCount)
CurveSample curvePoint(int idx)
{
    int count = max(segmentCount, 1);
    float t = TMIN + (TMAX - TMIN) * float(idx) / float(count);

    vec3 N = vec3(0,0,1);
    vec3 X = vec3(1,0,0);
    vec3 Y = vec3(0,1,0);

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
