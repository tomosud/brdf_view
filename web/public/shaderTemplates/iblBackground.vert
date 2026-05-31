#version 300 es
// Fullscreen triangle; passes NDC to the fragment stage for ray reconstruction.
out vec2 v_ndc;
void main(void)
{
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    v_ndc = p * 2.0 - 1.0;
    gl_Position = vec4(v_ndc, 1.0, 1.0);
}
