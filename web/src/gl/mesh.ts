// Geometry generation matching the original widgets.
// - Geodesic hemisphere: 40 base triangles linearly subdivided to depth 6,
//   left un-normalized (the vertex shader normalizes), exactly as
//   Plot3DWidget::subdivideTriangle / makeGeodesicHemisphereVBO.

import { GEODESIC_HEMISPHERE_VERTS } from './geodesic-hemisphere.js';

function subdivide(
  out: Float32Array,
  idx: { i: number },
  a: number[],
  b: number[],
  c: number[],
  depth: number,
): void {
  if (depth === 0) {
    out[idx.i++] = a[0]; out[idx.i++] = a[1]; out[idx.i++] = a[2];
    out[idx.i++] = b[0]; out[idx.i++] = b[1]; out[idx.i++] = b[2];
    out[idx.i++] = c[0]; out[idx.i++] = c[1]; out[idx.i++] = c[2];
    return;
  }
  const ab = [(b[0] - a[0]) * 0.5 + a[0], (b[1] - a[1]) * 0.5 + a[1], (b[2] - a[2]) * 0.5 + a[2]];
  const ac = [(c[0] - a[0]) * 0.5 + a[0], (c[1] - a[1]) * 0.5 + a[1], (c[2] - a[2]) * 0.5 + a[2]];
  const bc = [(c[0] - b[0]) * 0.5 + b[0], (c[1] - b[1]) * 0.5 + b[1], (c[2] - b[2]) * 0.5 + b[2]];
  subdivide(out, idx, a, ab, ac, depth - 1);
  subdivide(out, idx, ab, b, bc, depth - 1);
  subdivide(out, idx, ac, bc, c, depth - 1);
  subdivide(out, idx, ac, ab, bc, depth - 1);
}

export interface HemisphereMesh {
  positions: Float32Array;
  triangleCount: number;
}

/** Build the tessellated hemisphere (depth 6 => 40 * 4^6 = 163,840 triangles). */
export function buildHemisphere(depth = 6): HemisphereMesh {
  const triangleCount = 40 * 4 ** depth;
  const positions = new Float32Array(triangleCount * 9);
  const idx = { i: 0 };
  const v = GEODESIC_HEMISPHERE_VERTS;
  for (let t = 0; t < 40; t++) {
    const o = t * 9;
    subdivide(
      positions,
      idx,
      [v[o], v[o + 1], v[o + 2]],
      [v[o + 3], v[o + 4], v[o + 5]],
      [v[o + 6], v[o + 7], v[o + 8]],
      depth,
    );
  }
  return { positions, triangleCount };
}

export interface IndexedMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/**
 * UV sphere matching Sphere.cpp (theta = u/nU*PI, phi = v/nV*2PI). The lit-sphere
 * template only consumes vtx_position (it derives the normal as normalize(pos)),
 * so we emit positions + indices only. Default nU=nV=100.
 */
export function buildSphere(radius = 1.0, nU = 100, nV = 100): IndexedMesh {
  const positions = new Float32Array((nU + 1) * (nV + 1) * 3);
  for (let v = 0; v <= nV; v++) {
    for (let u = 0; u <= nU; u++) {
      const theta = (u / nU) * Math.PI;
      const phi = (v / nV) * Math.PI * 2;
      const i = (u + (nU + 1) * v) * 3;
      const nx = Math.sin(theta) * Math.cos(phi);
      const ny = Math.sin(theta) * Math.sin(phi);
      const nz = Math.cos(theta);
      positions[i] = nx * radius;
      positions[i + 1] = ny * radius;
      positions[i + 2] = nz * radius;
    }
  }
  const indices = new Uint32Array(nU * nV * 6);
  let k = 0;
  for (let v = 0; v < nV; v++) {
    for (let u = 0; u < nU; u++) {
      const vi = u + (nU + 1) * v;
      indices[k++] = vi;
      indices[k++] = vi + 1;
      indices[k++] = vi + 1 + (nU + 1);
      indices[k++] = vi;
      indices[k++] = vi + 1 + (nU + 1);
      indices[k++] = vi + (nU + 1);
    }
  }
  return { positions, indices };
}

/** Unit circle in the z=0 plane as a line loop (60 segments), matching Plot3DWidget. */
export function unitCircle(segments = 60): Float32Array {
  const out = new Float32Array(segments * 3);
  const inc = (2 * Math.PI) / segments;
  for (let i = 0; i < segments; i++) {
    out[i * 3] = Math.cos(i * inc);
    out[i * 3 + 1] = Math.sin(i * inc);
    out[i * 3 + 2] = 0;
  }
  return out;
}

export interface ColoredLines {
  positions: Float32Array; // xyz pairs
  colors: Float32Array; // rgb per vertex
  vertexCount: number;
}

/**
 * Direction indicators for the 3D plot: incident, normal, reflection, U, V.
 * Matches Plot3DWidget::createDirectionVAO (10 vertices / 5 line segments).
 */
export function directionLines(inTheta: number, inPhi: number, planeSize = 3.0): ColoredLines {
  const L = 5.0;
  const ix = Math.sin(inTheta) * Math.cos(inPhi);
  const iy = Math.sin(inTheta) * Math.sin(inPhi);
  const iz = Math.cos(inTheta);
  const positions = new Float32Array([
    0, 0, 0, L * ix, L * iy, L * iz, // incident (cyan)
    0, 0, 0, 0, 0, L, // normal (blue)
    0, 0, 0, -L * ix, -L * iy, L * iz, // reflection (magenta)
    0, 0, 0, planeSize, 0, 0, // U (red)
    0, 0, 0, 0, planeSize, 0, // V (green)
  ]);
  const colors = new Float32Array([
    0, 1, 1, 0, 1, 1,
    0, 0, 1, 0, 0, 1,
    1, 0, 1, 1, 0, 1,
    1, 0, 0, 1, 0, 0,
    0, 1, 0, 0, 1, 0,
  ]);
  return { positions, colors, vertexCount: 10 };
}
