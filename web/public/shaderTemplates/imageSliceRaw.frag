#version 300 es
precision highp float;
precision highp int;

uniform float useNDotL;
uniform float incidentPhi;
uniform float phiD;
uniform float exposure;
uniform float useThetaHSquared;

in vec2 texCoord;

out vec4 fragColor;

::INSERT_UNIFORMS_HERE::

::INSERT_BRDF_FUNCTION_HERE::

float Sqr( float x ) { return x * x; }

vec3 rotate_vector( vec3 v, vec3 axis, float angle )
{
    vec3 n;
    axis = normalize( axis );
    n = axis * dot( axis, v );
    return n + cos(angle)*(v-n) + sin(angle)*cross(axis, v);
}

void main()
{
    vec3 normal = vec3(0,0,1);
    vec3 tangent = vec3(1,0,0);
    vec3 bitangent = vec3(0,1,0);

    const float M_PI = 3.1415926535897932384626433832795;

    float thetaH = texCoord.r;
    if (useThetaHSquared != 0.0) thetaH = Sqr(thetaH) / (M_PI * 0.5);

    float thetaD = texCoord.g;

    float phiH = incidentPhi;
    float sinThetaH = sin(thetaH), cosThetaH = cos(thetaH);
    float sinPhiH = sin(phiH), cosPhiH = cos(phiH);
    vec3 H = vec3(sinThetaH*cosPhiH, sinThetaH*sinPhiH, cosThetaH );

    float sinThetaD = sin(thetaD), cosThetaD = cos(thetaD);
    float sinPhiD = sin(phiD), cosPhiD = cos(phiD);
    vec3 D = vec3(sinThetaD*cosPhiD, sinThetaD*sinPhiD, cosThetaD );

    vec3 L = rotate_vector( rotate_vector( D, bitangent, thetaH ), normal, phiH );
    vec3 V = 2.0*dot(H,L)*H - L;

    vec3 b = max(BRDF( L, V, normal, tangent, bitangent ), vec3(0.0));

    if (useNDotL != 0.0) b *= clamp(L[2], 0.0, 1.0);

    b *= pow( 2.0, exposure );

    fragColor = vec4( b, 1.0 );
}
