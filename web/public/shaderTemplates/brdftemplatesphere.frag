#version 300 es
// Ported to GLSL ES 3.00 from brdftemplatesphere.frag.
// Copyright Disney Enterprises, Inc. All rights reserved. See public/LICENSE.
precision highp float;
precision highp int;

uniform vec3 incidentVector;
uniform float incidentTheta;
uniform float incidentPhi;

uniform float brightness;
uniform float gamma;
uniform float exposure;
uniform float useNDotL;

in vec4 worldSpaceVert;
in vec4 eyeSpaceVert;

out vec4 fragColor;

::INSERT_UNIFORMS_HERE::

::INSERT_BRDF_FUNCTION_HERE::


vec3 computeWithDirectionalLight( vec3 surfPt, vec3 incidentVector, vec3 viewVec, vec3 normal, vec3 tangent, vec3 bitangent )
{
    // evaluate the BRDF
    vec3 b = max( BRDF( incidentVector, viewVec, normal, tangent, bitangent ), vec3(0.0) );

    // multiply in the cosine factor
    if (useNDotL != 0.0)
        b *= dot( normal, incidentVector );

    return b;
}


void main(void)
{
    // orthogonal vectors
    vec3 normal = normalize( worldSpaceVert.xyz );
    vec3 tangent = normalize( cross( vec3(0,1,0), normal ) );
    vec3 bitangent = normalize( cross( normal, tangent ) );

    // ortho viewing mode
    vec3 surfacePos = normalize( worldSpaceVert.xyz );
    vec3 viewVec = vec3(0,0,1);

    vec3 b = computeWithDirectionalLight( surfacePos, incidentVector, viewVec, normal, tangent, bitangent );

    // brightness
    b *= brightness;

    // exposure
    b *= pow( 2.0, exposure );

    // gamma
    b = pow( b, vec3( 1.0 / gamma ) );

    fragColor = vec4( clamp( b, vec3(0.0), vec3(1.0) ), 1.0 );
}
