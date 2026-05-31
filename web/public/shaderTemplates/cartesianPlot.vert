#version 300 es
// Cartesian Theta V plot. Reimplements brdftemplateAnglePlot.vert + the miter
// geometry shader: x = viewing theta in [-pi/2, pi/2], y = BRDF value, expanded
// to a screen-space miter quad via gl_VertexID. modelViewMatrix carries the
// per-axis scale (scaleX, scaleY).
// Copyright Disney Enterprises, Inc. (original templates). See public/LICENSE.

uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform vec3 incidentVector;
uniform float incidentPhi;
uniform float useLogPlot;
uniform float useNDotL;
uniform float phiV;
uniform vec3 colorMask;
uniform vec2 viewport_size;
uniform float thickness;

::INSERT_UNIFORMS_HERE::

::INSERT_BRDF_FUNCTION_HERE::

::INSERT_MITER_HERE::

const int SEGMENTS = 512;
const float TMIN = -1.57079633;
const float TMAX = 1.57079633;

float modifyLog( float x ) { return log(max(x, 0.0) + 1.0) * 0.434294482; }

// model-space curve point (theta, brdfValue) at sample idx (0..SEGMENTS)
vec2 curvePoint(int idx)
{
    float t = TMIN + (TMAX - TMIN) * float(idx) / float(SEGMENTS);

    vec3 N = vec3(0,0,1);
    vec3 X = vec3(1,0,0);
    vec3 Y = vec3(0,1,0);
    vec3 nIV = normalize(incidentVector);

    float yAngle = -t;
    vec3 V = normalize( vec3( sin(yAngle) * cos(phiV),
                              sin(yAngle) * sin(phiV),
                              cos(yAngle) ) );

    vec3 bRes = BRDF( nIV, V, N, X, Y );
    float b = dot( bRes, colorMask );
    b *= (useNDotL > 0.5 ? max(dot( N, nIV ), 0.0) : 1.0);
    b = max(b, 0.0);
    float radius = useLogPlot > 0.5 ? modifyLog( b ) : b;
    return vec2(t, radius);
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

    vec2 prev  = toScreen(curvePoint(max(seg - 1, 0)));
    vec2 start = toScreen(curvePoint(seg));
    vec2 end   = toScreen(curvePoint(seg + 1));
    vec2 next  = toScreen(curvePoint(min(seg + 2, SEGMENTS)));

    int order = CORNER_ORDER[corner];
    vec2 p = miterCorner(order, prev, start, end, next, thickness, seg == 0, seg == SEGMENTS - 1);
    gl_Position = vec4(p / viewport_size, 0.0, 1.0);
}
