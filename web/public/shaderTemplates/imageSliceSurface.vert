#version 300 es
precision highp float;
precision highp int;

uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform float useNDotL;
uniform float incidentPhi;
uniform float phiD;
uniform float exposure;
uniform float useThetaHSquared;
uniform float heightScale;
uniform float useLogPlot;

out vec3 hdrColor;
out float heightValue;

::INSERT_UNIFORMS_HERE::

::INSERT_BRDF_FUNCTION_HERE::

const int GRID = 96;

float Sqr( float x ) { return x * x; }

vec3 rotate_vector( vec3 v, vec3 axis, float angle )
{
    vec3 n;
    axis = normalize( axis );
    n = axis * dot( axis, v );
    return n + cos(angle)*(v-n) + sin(angle)*cross(axis, v);
}

vec2 vertexUv(int id)
{
    int tri = id / 6;
    int corner = id - tri * 6;
    int x = tri % GRID;
    int y = tri / GRID;
    vec2 cell = vec2(float(x), float(y)) / float(GRID);
    vec2 stepv = vec2(1.0 / float(GRID));
    if (corner == 0) return cell;
    if (corner == 1) return cell + vec2(stepv.x, 0.0);
    if (corner == 2) return cell + stepv;
    if (corner == 3) return cell;
    if (corner == 4) return cell + stepv;
    return cell + vec2(0.0, stepv.y);
}

vec3 evalSlice(vec2 uv)
{
    vec3 normal = vec3(0,0,1);
    vec3 tangent = vec3(1,0,0);
    vec3 bitangent = vec3(0,1,0);

    const float M_PI = 3.1415926535897932384626433832795;

    float thetaH = uv.x * M_PI * 0.5;
    if (useThetaHSquared != 0.0) thetaH = Sqr(thetaH) / (M_PI * 0.5);

    float thetaD = uv.y * M_PI * 0.5;

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
    return b * pow(2.0, exposure);
}

void main()
{
    vec2 uv = vertexUv(gl_VertexID);
    vec3 b = evalSlice(uv);
    float luma = dot(b, vec3(0.3, 0.59, 0.11));
    float heightValueRaw = useLogPlot != 0.0 ? log(max(luma, 0.0) + 1.0) : max(luma, 0.0);
    float height = heightValueRaw * heightScale;
    hdrColor = b;
    heightValue = height;
    vec3 pos = vec3((uv.x - 0.5) * 2.0, height, (0.5 - uv.y) * 2.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
