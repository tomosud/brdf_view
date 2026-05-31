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
  normals?: Float32Array;
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
  return { positions, normals: positions.slice(), indices };
}

export function parseObjMesh(text: string): IndexedMesh {
  const srcPositions: number[][] = [];
  const srcNormals: number[][] = [];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const keyToIndex = new Map<string, number>();

  const addVertex = (token: string): number => {
    const cached = keyToIndex.get(token);
    if (cached !== undefined) return cached;
    const [vRaw, , nRaw] = token.split('/');
    const p = srcPositions[Number(vRaw) - 1];
    if (!p) throw new Error(`OBJ references missing vertex ${token}`);
    const n = nRaw ? srcNormals[Number(nRaw) - 1] : undefined;
    const idx = positions.length / 3;
    positions.push(p[0], p[1], p[2]);
    if (n) normals.push(n[0], n[1], n[2]);
    else {
      const l = Math.hypot(p[0], p[1], p[2]) || 1;
      normals.push(p[0] / l, p[1] / l, p[2] / l);
    }
    keyToIndex.set(token, idx);
    return idx;
  };

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts[0] === 'v') {
      srcPositions.push([Number(parts[1]), Number(parts[2]), Number(parts[3])]);
    } else if (parts[0] === 'vn') {
      srcNormals.push([Number(parts[1]), Number(parts[2]), Number(parts[3])]);
    } else if (parts[0] === 'f') {
      const face = parts.slice(1).map(addVertex);
      for (let i = 1; i + 1 < face.length; i++) {
        indices.push(face[0], face[i], face[i + 1]);
      }
    }
  }

  normalizePositions(positions);
  const finalNormals = srcNormals.length ? normals : computeVertexNormals(positions, indices);
  return { positions: new Float32Array(positions), normals: new Float32Array(finalNormals), indices: new Uint32Array(indices) };
}

function normalizePositions(positions: number[]): void {
  if (!positions.length) return;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
    minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1]);
    minZ = Math.min(minZ, positions[i + 2]); maxZ = Math.max(maxZ, positions[i + 2]);
  }
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const scale = 2 / Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = (positions[i] - cx) * scale;
    positions[i + 1] = (positions[i + 1] - cy) * scale;
    positions[i + 2] = (positions[i + 2] - cz) * scale;
  }
}

function computeVertexNormals(positions: number[], indices: number[]): number[] {
  const normals = new Array<number>(positions.length).fill(0);
  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i] * 3;
    const ib = indices[i + 1] * 3;
    const ic = indices[i + 2] * 3;
    const abx = positions[ib] - positions[ia];
    const aby = positions[ib + 1] - positions[ia + 1];
    const abz = positions[ib + 2] - positions[ia + 2];
    const acx = positions[ic] - positions[ia];
    const acy = positions[ic + 1] - positions[ia + 1];
    const acz = positions[ic + 2] - positions[ia + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    normals[ia] += nx; normals[ia + 1] += ny; normals[ia + 2] += nz;
    normals[ib] += nx; normals[ib + 1] += ny; normals[ib + 2] += nz;
    normals[ic] += nx; normals[ic + 1] += ny; normals[ic + 2] += nz;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= l;
    normals[i + 1] /= l;
    normals[i + 2] /= l;
  }
  return normals;
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
