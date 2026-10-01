// Web Worker entry: builds the occlusion BVH off the main thread (see bvh.ts).

import { buildBvh } from './bvh.js';

interface BvhRequest {
  positions: Float32Array;
  indices: Uint32Array;
  normals?: Float32Array;
}

self.onmessage = (e: MessageEvent<BvhRequest>) => {
  const { positions, indices, normals } = e.data;
  const bvh = buildBvh(positions, indices, normals);
  (self as unknown as Worker).postMessage(bvh, bvh ? [bvh.nodes.buffer, bvh.tris.buffer] : []);
};
