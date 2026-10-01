// Triangle BVH for the Lit Object ray-traced self-occlusion ("Ray" mode).
//
// Binned SAH build over triangle centroids (BIN_COUNT bins per axis, leaves of
// at most MAX_LEAF_TRIS triangles). Nodes are stored depth-first: the left child
// of node i is i + 1, the right child index is stored in the node. The result is
// packed for RGBA32F textures read with texelFetch (TEXTURE_WIDTH texels per row):
//   nodes: 2 texels per node
//     [min.xyz, leaf ? first triangle : right child]
//     [max.xyz, leaf ? triangle count : 0]
//   triangles: 3 texels per triangle, in leaf order
//     [v0.xyz, 0] [e1.xyz, 0] [e2.xyz, 0]   (e1 = v1 - v0, e2 = v2 - v0)
// Triangles are wound so cross(e1, e2) agrees with the vertex normals, so the
// shader can tell front faces from back faces without the original winding.
// The traversal in public/shaderTemplates/iblObject.frag (occludedRay) must
// match this layout, TEXTURE_WIDTH and MAX_DEPTH (its stack size).
//
// Pure TypeScript (no DOM / GL), so it can also run in Node or a worker.

/** Texels per row of the packed textures (a power of two; the shader uses i & 2047, i >> 11). */
export const BVH_TEXTURE_WIDTH = 2048;
/** Deepest node level; the shader's traversal stack holds this many entries. */
export const BVH_MAX_DEPTH = 48;

const BIN_COUNT = 16;
const MAX_LEAF_TRIS = 4;
/** SAH cost of one node traversal relative to one triangle test. */
const TRAVERSAL_COST = 1.0;

export interface PackedBvh {
  /** RGBA32F texels, BVH_TEXTURE_WIDTH x nodeRows. */
  nodes: Float32Array;
  nodeRows: number;
  /** RGBA32F texels, BVH_TEXTURE_WIDTH x triRows. */
  tris: Float32Array;
  triRows: number;
  nodeCount: number;
  triCount: number;
  depth: number;
}

/** Build and pack a BVH for an indexed triangle mesh. Returns null for an empty mesh. */
export function buildBvh(positions: Float32Array, indices: Uint32Array, normals?: Float32Array): PackedBvh | null {
  const triCount = Math.floor(indices.length / 3);
  if (triCount === 0) return null;

  // per-triangle bounds and centroids
  const bmin = new Float32Array(triCount * 3);
  const bmax = new Float32Array(triCount * 3);
  const cent = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    for (let k = 0; k < 3; k++) {
      const pa = positions[a + k], pb = positions[b + k], pc = positions[c + k];
      const lo = Math.min(pa, pb, pc);
      const hi = Math.max(pa, pb, pc);
      bmin[t * 3 + k] = lo;
      bmax[t * 3 + k] = hi;
      cent[t * 3 + k] = (lo + hi) * 0.5;
    }
  }

  const order = new Uint32Array(triCount);
  for (let i = 0; i < triCount; i++) order[i] = i;

  const maxNodes = 2 * triCount - 1;
  const nodeMin = new Float32Array(maxNodes * 3);
  const nodeMax = new Float32Array(maxNodes * 3);
  const nodeA = new Int32Array(maxNodes); // leaf: first triangle, internal: right child
  const nodeCountTris = new Int32Array(maxNodes); // leaf: triangle count, internal: 0
  let nodeCount = 0;
  let maxDepth = 0;

  const binCount = new Int32Array(BIN_COUNT);
  const binMin = new Float64Array(BIN_COUNT * 3);
  const binMax = new Float64Array(BIN_COUNT * 3);
  const rightArea = new Float64Array(BIN_COUNT);
  const rightCnt = new Int32Array(BIN_COUNT);

  // task stack: start, end, depth, parent (right child to patch, or -1)
  const taskStart: number[] = [0];
  const taskEnd: number[] = [triCount];
  const taskDepth: number[] = [1];
  const taskParent: number[] = [-1];

  while (taskStart.length) {
    const start = taskStart.pop()!;
    const end = taskEnd.pop()!;
    const depth = taskDepth.pop()!;
    const parent = taskParent.pop()!;
    const node = nodeCount++;
    if (parent >= 0) nodeA[parent] = node;
    maxDepth = Math.max(maxDepth, depth);

    // node bounds and centroid bounds
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
    for (let i = start; i < end; i++) {
      const t = order[i] * 3;
      if (bmin[t] < x0) x0 = bmin[t];
      if (bmin[t + 1] < y0) y0 = bmin[t + 1];
      if (bmin[t + 2] < z0) z0 = bmin[t + 2];
      if (bmax[t] > x1) x1 = bmax[t];
      if (bmax[t + 1] > y1) y1 = bmax[t + 1];
      if (bmax[t + 2] > z1) z1 = bmax[t + 2];
      const cx = cent[t], cy = cent[t + 1], cz = cent[t + 2];
      if (cx < cx0) cx0 = cx;
      if (cy < cy0) cy0 = cy;
      if (cz < cz0) cz0 = cz;
      if (cx > cx1) cx1 = cx;
      if (cy > cy1) cy1 = cy;
      if (cz > cz1) cz1 = cz;
    }
    nodeMin[node * 3] = x0; nodeMin[node * 3 + 1] = y0; nodeMin[node * 3 + 2] = z0;
    nodeMax[node * 3] = x1; nodeMax[node * 3 + 1] = y1; nodeMax[node * 3 + 2] = z1;

    const n = end - start;
    const makeLeaf = () => {
      nodeA[node] = start;
      nodeCountTris[node] = n;
    };
    if (n <= 1 || depth >= BVH_MAX_DEPTH) {
      makeLeaf();
      continue;
    }

    // best binned SAH split over the three axes
    const cmin = [cx0, cy0, cz0];
    const cext = [cx1 - cx0, cy1 - cy0, cz1 - cz0];
    let bestCost = Infinity;
    let bestAxis = -1;
    let bestBin = 0;
    for (let axis = 0; axis < 3; axis++) {
      if (!(cext[axis] > 1e-12)) continue;
      const scale = BIN_COUNT / cext[axis];
      binCount.fill(0);
      binMin.fill(Infinity);
      binMax.fill(-Infinity);
      for (let i = start; i < end; i++) {
        const t = order[i] * 3;
        const b = Math.min(BIN_COUNT - 1, Math.floor((cent[t + axis] - cmin[axis]) * scale));
        binCount[b]++;
        const o = b * 3;
        for (let k = 0; k < 3; k++) {
          if (bmin[t + k] < binMin[o + k]) binMin[o + k] = bmin[t + k];
          if (bmax[t + k] > binMax[o + k]) binMax[o + k] = bmax[t + k];
        }
      }
      // sweep from the right: area / count of bins b..BIN_COUNT-1
      let ax0 = Infinity, ay0 = Infinity, az0 = Infinity, ax1 = -Infinity, ay1 = -Infinity, az1 = -Infinity;
      let cnt = 0;
      for (let b = BIN_COUNT - 1; b > 0; b--) {
        const o = b * 3;
        if (binCount[b]) {
          ax0 = Math.min(ax0, binMin[o]); ay0 = Math.min(ay0, binMin[o + 1]); az0 = Math.min(az0, binMin[o + 2]);
          ax1 = Math.max(ax1, binMax[o]); ay1 = Math.max(ay1, binMax[o + 1]); az1 = Math.max(az1, binMax[o + 2]);
        }
        cnt += binCount[b];
        rightCnt[b] = cnt;
        rightArea[b] = cnt ? halfArea(ax1 - ax0, ay1 - ay0, az1 - az0) : 0;
      }
      // sweep from the left: split between bin b-1 and b
      ax0 = Infinity; ay0 = Infinity; az0 = Infinity; ax1 = -Infinity; ay1 = -Infinity; az1 = -Infinity;
      cnt = 0;
      for (let b = 1; b < BIN_COUNT; b++) {
        const o = (b - 1) * 3;
        if (binCount[b - 1]) {
          ax0 = Math.min(ax0, binMin[o]); ay0 = Math.min(ay0, binMin[o + 1]); az0 = Math.min(az0, binMin[o + 2]);
          ax1 = Math.max(ax1, binMax[o]); ay1 = Math.max(ay1, binMax[o + 1]); az1 = Math.max(az1, binMax[o + 2]);
        }
        cnt += binCount[b - 1];
        if (cnt === 0 || rightCnt[b] === 0) continue;
        const cost = cnt * halfArea(ax1 - ax0, ay1 - ay0, az1 - az0) + rightCnt[b] * rightArea[b];
        if (cost < bestCost) {
          bestCost = cost;
          bestAxis = axis;
          bestBin = b;
        }
      }
    }

    const nodeArea = halfArea(x1 - x0, y1 - y0, z1 - z0);
    const leafCost = n;
    const splitCost = nodeArea > 0 ? TRAVERSAL_COST + bestCost / nodeArea : Infinity;
    let mid: number;
    if (bestAxis < 0) {
      // all centroids coincide: split in the middle of the list
      if (n <= MAX_LEAF_TRIS) {
        makeLeaf();
        continue;
      }
      mid = start + (n >> 1);
    } else {
      if (n <= MAX_LEAF_TRIS && leafCost <= splitCost) {
        makeLeaf();
        continue;
      }
      // partition by bin
      const scale = BIN_COUNT / cext[bestAxis];
      let i = start;
      let j = end - 1;
      while (i <= j) {
        const t = order[i];
        const b = Math.min(BIN_COUNT - 1, Math.floor((cent[t * 3 + bestAxis] - cmin[bestAxis]) * scale));
        if (b < bestBin) {
          i++;
        } else {
          order[i] = order[j];
          order[j] = t;
          j--;
        }
      }
      mid = i;
      if (mid === start || mid === end) mid = start + (n >> 1);
    }

    nodeCountTris[node] = 0;
    // right first, so the left child is popped next and becomes node + 1
    taskStart.push(mid, start);
    taskEnd.push(end, mid);
    taskDepth.push(depth + 1, depth + 1);
    taskParent.push(node, -1);
  }

  // pack nodes
  const nodeRows = Math.ceil((nodeCount * 2) / BVH_TEXTURE_WIDTH);
  const nodes = new Float32Array(nodeRows * BVH_TEXTURE_WIDTH * 4);
  for (let i = 0; i < nodeCount; i++) {
    const o = i * 8;
    nodes[o] = nodeMin[i * 3];
    nodes[o + 1] = nodeMin[i * 3 + 1];
    nodes[o + 2] = nodeMin[i * 3 + 2];
    nodes[o + 3] = nodeA[i];
    nodes[o + 4] = nodeMax[i * 3];
    nodes[o + 5] = nodeMax[i * 3 + 1];
    nodes[o + 6] = nodeMax[i * 3 + 2];
    nodes[o + 7] = nodeCountTris[i];
  }

  // pack triangles in leaf order, front faces along the vertex normals
  const triRows = Math.ceil((triCount * 3) / BVH_TEXTURE_WIDTH);
  const tris = new Float32Array(triRows * BVH_TEXTURE_WIDTH * 4);
  for (let i = 0; i < triCount; i++) {
    const t = order[i];
    const a = indices[t * 3] * 3;
    let b = indices[t * 3 + 1] * 3;
    let c = indices[t * 3 + 2] * 3;
    if (normals) {
      const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2];
      const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const sx = normals[a] + normals[b] + normals[c];
      const sy = normals[a + 1] + normals[b + 1] + normals[c + 1];
      const sz = normals[a + 2] + normals[b + 2] + normals[c + 2];
      if (nx * sx + ny * sy + nz * sz < 0) {
        const tmp = b;
        b = c;
        c = tmp;
      }
    }
    const o = i * 12;
    for (let k = 0; k < 3; k++) {
      tris[o + k] = positions[a + k];
      tris[o + 4 + k] = positions[b + k] - positions[a + k];
      tris[o + 8 + k] = positions[c + k] - positions[a + k];
    }
  }

  return { nodes, nodeRows, tris, triRows, nodeCount, triCount, depth: maxDepth };
}

function halfArea(dx: number, dy: number, dz: number): number {
  return dx * dy + dy * dz + dz * dx;
}

/**
 * Build in a Web Worker (one per call) so a large mesh does not freeze the page.
 * Falls back to building on the calling thread when workers are unavailable.
 */
export function buildBvhAsync(positions: Float32Array, indices: Uint32Array, normals?: Float32Array): Promise<PackedBvh | null> {
  let worker: Worker;
  try {
    worker = new Worker(new URL('./bvh-worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return Promise.resolve().then(() => buildBvh(positions, indices, normals));
  }
  return new Promise<PackedBvh | null>((resolve) => {
    worker.onmessage = (e: MessageEvent<PackedBvh | null>) => {
      worker.terminate();
      resolve(e.data);
    };
    worker.onerror = (e) => {
      worker.terminate();
      console.warn(`[brdfView] BVH worker failed (${e.message}); building on the main thread`);
      resolve(buildBvh(positions, indices, normals));
    };
    worker.postMessage({ positions, indices, normals });
  });
}
