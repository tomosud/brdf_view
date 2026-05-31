// Geometry-shader replacement for thick miter-joined plot lines.
//
// The original draws plot curves as GL_LINE_STRIP_ADJACENCY through
// brdftemplatePlot.geom, which expands each segment into a screen-space miter
// quad. WebGL2 has no geometry shader, so instead each curve segment is drawn
// as 6 vertices (two triangles); the plot vertex shader derives segment and
// corner from gl_VertexID, evaluates the curve at the 4 neighbor samples
// (prev/start/end/next), and computes the same miter via miterCorner().
//
// MITER_GLSL is spliced into plot templates at ::INSERT_MITER_HERE:: by
// shader-builder. Templates define their own `vec2 curvePoint(int idx)`.
//
// Simplification vs the original: the degenerate gap-fill triangles emitted at
// sharp corners (MITER_LIMIT) are omitted; the miter clamp itself is kept, so
// smooth BRDF curves match. Revisit if a BRDF produces very sharp kinks.

export const VERTS_PER_SEGMENT = 6;

/** GLSL (ES 3.00) miter helper. Mirrors brdftemplatePlot.geom math. */
export const MITER_GLSL = `
// quad corner order for the two triangles of a segment: a,d,b, d,b,c
const int CORNER_ORDER[6] = int[6](0, 1, 2, 1, 2, 3);

// order: 0=a (start-), 1=d (start+), 2=b (end-), 3=c (end+); positions in screen px
vec2 miterCorner(int order, vec2 prev, vec2 start, vec2 end, vec2 next,
                 float thickness, bool isFirst, bool isLast)
{
    vec2 v1 = normalize(end - start);
    vec2 v0 = isFirst ? v1 : normalize(start - prev);
    vec2 v2 = isLast ? v1 : normalize(next - end);

    vec2 n0 = vec2(-v0.y, v0.x);
    vec2 n1 = vec2(-v1.y, v1.x);
    vec2 n2 = vec2(-v2.y, v2.x);

    vec2 miter_a = normalize(n0 + n1);
    vec2 miter_b = normalize(n1 + n2);
    float length_a = thickness / dot(miter_a, n1);
    float length_b = thickness / dot(miter_b, n1);

    // clamp excessively long miters at sharp corners (MITER_LIMIT = 0.75)
    if (dot(v0, v1) < -0.75) { miter_a = n1; length_a = thickness; }
    if (dot(v1, v2) < -0.75) { miter_b = n1; length_b = thickness; }

    vec2 a = isFirst ? (start - n1 * thickness) : (start - length_a * miter_a);
    vec2 d = isFirst ? (start + n1 * thickness) : (start + length_a * miter_a);
    vec2 b = isLast  ? (end   - n1 * thickness) : (end   - length_b * miter_b);
    vec2 c = isLast  ? (end   + n1 * thickness) : (end   + length_b * miter_b);

    if (order == 0) return a;
    if (order == 1) return d;
    if (order == 2) return b;
    return c;
}
`;

/** A bound empty VAO is required to issue attribute-less (gl_VertexID-only) draws. */
export function createEmptyVAO(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const vao = gl.createVertexArray();
  if (!vao) throw new Error('createVertexArray failed');
  return vao;
}
