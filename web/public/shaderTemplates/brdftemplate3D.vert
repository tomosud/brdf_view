#version 300 es
// Ported to GLSL ES 3.00 from the Disney BRDF Explorer template brdftemplate3D.vert.
// Copyright Disney Enterprises, Inc. All rights reserved. See public/LICENSE.

uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform vec3 incidentVector;
uniform float incidentTheta;
uniform float incidentPhi;
uniform float useLogPlot;
uniform float useNDotL;
uniform vec3 colorMask;

in vec3 vtx_position;

out vec4 eyeSpaceVert;

::INSERT_UNIFORMS_HERE::

::INSERT_BRDF_FUNCTION_HERE::


float modifyLog( float x )
{
    // log base 10
    return log(max(x, 0.0) + 1.0) * 0.434294482;
}


void main(void)
{
    // get the input vertex and normalize it to create the unit hemisphere
    vec4 inPos = vec4(vtx_position,1);
    vec3 normalizedInPos = normalize( inPos.xyz );
    vec3 normalizedIncidentVector = normalize(incidentVector);

    // orthonormal vectors
    vec3 normal = vec3(0,0,1);
    vec3 tangent = vec3(1,0,0);
    vec3 bitangent = vec3(0,1,0);

    // calculate the radial value of the BRDF at this output vector
    vec3 bRes = BRDF( normalizedIncidentVector, normalizedInPos, normal, tangent, bitangent );
    float b = dot( bRes, colorMask );
    b *= (useNDotL > 0.5 ? max(dot( normal, normalizedIncidentVector ), 0.0) : 1.0);
    b = max(b, 0.0);
    float radius = useLogPlot > 0.5 ? modifyLog( b ) : b;

    // now displace the vertex by that much
    inPos.xyz = normalizedInPos * radius;

    // do the necessary transformations
    eyeSpaceVert = modelViewMatrix * inPos;
    gl_Position = projectionMatrix * eyeSpaceVert;
}
