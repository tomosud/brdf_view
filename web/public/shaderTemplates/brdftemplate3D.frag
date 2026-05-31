#version 300 es
// Ported to GLSL ES 3.00 from the Disney BRDF Explorer template brdftemplate3D.frag.
// Copyright Disney Enterprises, Inc. All rights reserved. See public/LICENSE.
precision highp float;
precision highp int;

uniform vec3 drawColor;

in vec4 eyeSpaceVert;

out vec4 fragColor;

void main(void)
{
    vec3 viewVec = -normalize(eyeSpaceVert.xyz);

    // since we're distorting the sphere all over the place, can't really use the sphere normal.
    // instead compute a per-pixel normal based on the derivative of the eye-space vertex position.
    vec3 normal = normalize( cross( dFdx(eyeSpaceVert.xyz), dFdy(eyeSpaceVert.xyz) ) );
    vec3 ref = reflect( -viewVec, normal );

    // simple phong shading
    vec3 q = drawColor * dot( normal, viewVec );
    q += vec3(0.4) * pow( max( dot( ref, viewVec ), 0.0 ), 10.0 );

    fragColor = vec4( q, 1 );
}
