#version 300 es
// Image Slice quad. Reproduces ImageSliceWidget's quad (positions [-1,1],
// texcoords [0, pi/2]) via gl_VertexID; texCoord.r = thetaH, .g = thetaD.

out vec2 texCoord;

const vec2 P[6] = vec2[6](
    vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 1.0),
    vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0)
);

void main(void)
{
    vec2 uv = P[gl_VertexID];
    texCoord = uv * 1.57079633;       // [0 .. pi/2]
    gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}
