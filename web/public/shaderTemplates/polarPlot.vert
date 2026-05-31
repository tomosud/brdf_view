#version 300 es
// Polar BRDF curve. Reimplements brdftemplate2D.vert + brdftemplatePlot.geom
// without a geometry shader: gl_VertexID -> (segment, corner); the curve is
// evaluated at 4 neighbor angles and expanded into a screen-space miter quad.
// Copyright Disney Enterprises, Inc. (original templates). See public/LICENSE.

uniform mat4 projectionMatrix;
uniform vec3 incidentVector;
uniform float incidentPhi;
uniform float useLogPlot;
uniform float useNDotL;
uniform vec3 colorMask;
uniform vec2 viewport_size;
uniform float thickness;

::INSERT_UNIFORMS_HERE::

::INSERT_BRDF_FUNCTION_HERE::

::INSERT_MITER_HERE::

const int SEGMENTS = 360;
const float INC = 3.14159265 / 360.0;

float modifyLog( float x ) { return log(max(x, 0.0) + 1.0) * 0.434294482; }

// world-space curve point at sample idx (0..SEGMENTS)
vec2 curvePoint(int idx)
{
    float angle = float(idx) * INC;
    vec2 dir = vec2(cos(angle), sin(angle));

    vec3 nIV = normalize(incidentVector);
    vec3 tangent = vec3(1,0,0);
    vec3 bitangent = vec3(0,1,0);
    vec3 normal = vec3(0,0,1);

    float yAngle = angle - 1.57079633;
    vec3 viewingVector = normalize( vec3( sin(yAngle) * cos(incidentPhi),
                                          sin(yAngle) * sin(incidentPhi),
                                          cos(yAngle) ) );

    vec3 bRes = BRDF( nIV, viewingVector, normal, tangent, bitangent );
    float b = dot( bRes, colorMask );
    b *= (useNDotL > 0.5 ? max(dot( normal, nIV ), 0.0) : 1.0);
    b = max(b, 0.0);
    float radius = useLogPlot > 0.5 ? modifyLog( b ) : b;
    return dir * radius;
}

vec2 toScreen(vec2 world)
{
    vec4 clip = projectionMatrix * vec4(world, 0.0, 1.0);
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
