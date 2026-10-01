#version 300 es
// Full-screen triangle for the numeric evaluation pass (see evaluate.frag).

void main(void)
{
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
