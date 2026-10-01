// Per-vertex self-occlusion for the Lit Object IBL integrator.
//
// At mesh load the mesh is rendered as an orthographic depth map from K
// directions spread over the sphere. For each vertex and direction d inside the
// vertex normal's hemisphere, a depth comparison (3x3 PCF) says whether the
// mesh blocks d. The blocked fraction O(d) is projected onto real spherical
// harmonics up to l = 3 (16 coefficients per vertex):
//   c_i = sum_d O(d) * Y_i(d) * 4pi / K
// The shader evaluates V(L) = 1 - clamp(sum_i c_i Y_i(L), 0, 1) per Monte-Carlo
// sample. Projecting the occlusion (not the visibility) keeps unoccluded
// vertices exactly at zero, so convex shapes such as the sphere are unchanged.
//
// Requires EXT_color_buffer_float (RGBA32F MRT targets and float readback);
// returns null without it. The real SH basis must match occlusionSH() in
// public/shaderTemplates/iblObject.frag.

import { buildProgram } from './renderer.js';

export const OCCLUSION_SH_COEFFS = 16;

const DIRECTION_COUNT = 512;
const DEPTH_RES = 1024;
const VERTEX_TEX_WIDTH = 2048;

export interface VisibilityBakeInput {
  positions: Float32Array;
  normals: Float32Array;
  posVBO: WebGLBuffer;
  idxVBO: WebGLBuffer;
  indexCount: number;
}

/** Returns 16 floats per vertex (occlusion SH), or null when unsupported. */
export function bakeOcclusionSH(gl: WebGL2RenderingContext, input: VisibilityBakeInput): Float32Array | null {
  if (!gl.getExtension('EXT_color_buffer_float')) return null;
  const vertexCount = input.positions.length / 3;
  if (vertexCount === 0) return null;

  let radius = 1e-6;
  for (let i = 0; i < input.positions.length; i += 3) {
    radius = Math.max(radius, Math.hypot(input.positions[i], input.positions[i + 1], input.positions[i + 2]));
  }
  radius *= 1.01;
  const texelWorld = (2 * radius) / DEPTH_RES;

  const width = Math.min(VERTEX_TEX_WIDTH, vertexCount);
  const height = Math.ceil(vertexCount / width);
  const texels = width * height;

  const posData = new Float32Array(texels * 4);
  const nrmData = new Float32Array(texels * 4);
  for (let v = 0; v < vertexCount; v++) {
    posData.set(input.positions.subarray(v * 3, v * 3 + 3), v * 4);
    nrmData.set(input.normals.subarray(v * 3, v * 3 + 3), v * 4);
  }

  const created: { textures: WebGLTexture[]; framebuffers: WebGLFramebuffer[]; programs: WebGLProgram[] } = {
    textures: [],
    framebuffers: [],
    programs: [],
  };
  const floatTexture = (data: Float32Array | null): WebGLTexture => {
    const t = gl.createTexture()!;
    created.textures.push(t);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data);
    return t;
  };

  const vao = gl.createVertexArray()!;
  try {
    const posTex = floatTexture(posData);
    const nrmTex = floatTexture(nrmData);

    const depthTex = gl.createTexture()!;
    created.textures.push(depthTex);
    gl.bindTexture(gl.TEXTURE_2D, depthTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT32F, DEPTH_RES, DEPTH_RES, 0, gl.DEPTH_COMPONENT, gl.FLOAT, null);
    const depthFB = gl.createFramebuffer()!;
    created.framebuffers.push(depthFB);
    gl.bindFramebuffer(gl.FRAMEBUFFER, depthFB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;

    const accum = [0, 1].map(() => {
      const textures = [0, 1, 2, 3].map(() => floatTexture(new Float32Array(texels * 4)));
      const fb = gl.createFramebuffer()!;
      created.framebuffers.push(fb);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      textures.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3]);
      return { fb, textures };
    });
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;

    const depthProgram = buildProgram(gl, DEPTH_VERT, DEPTH_FRAG, 'occlusionDepth');
    const accumProgram = buildProgram(gl, ACCUM_VERT, ACCUM_FRAG, 'occlusionAccum');
    created.programs.push(depthProgram, accumProgram);
    const loc = (p: WebGLProgram, n: string) => gl.getUniformLocation(p, n);

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, input.posVBO);
    const posLoc = gl.getAttribLocation(depthProgram, 'pos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, input.idxVBO);

    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.depthFunc(gl.LESS);

    const weight = (4 * Math.PI) / DIRECTION_COUNT;
    let read = 0;
    for (let k = 0; k < DIRECTION_COUNT; k++) {
      const [dz, dx, dy] = directionBasis(k);

      // depth map seen from direction d (nearest surface toward d)
      gl.bindVertexArray(vao);
      gl.bindFramebuffer(gl.FRAMEBUFFER, depthFB);
      gl.viewport(0, 0, DEPTH_RES, DEPTH_RES);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.clearDepth(1);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.useProgram(depthProgram);
      gl.uniform3f(loc(depthProgram, 'dirZ'), ...dz);
      gl.uniform3f(loc(depthProgram, 'dirX'), ...dx);
      gl.uniform3f(loc(depthProgram, 'dirY'), ...dy);
      gl.uniform1f(loc(depthProgram, 'invR'), 1 / radius);
      gl.drawElements(gl.TRIANGLES, input.indexCount, gl.UNSIGNED_INT, 0);

      // accumulate O(d) * Y(d) into the other ping-pong set
      const write = 1 - read;
      gl.bindVertexArray(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, accum[write].fb);
      gl.viewport(0, 0, width, height);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.useProgram(accumProgram);
      const units = [posTex, nrmTex, depthTex, ...accum[read].textures];
      const names = ['posTex', 'nrmTex', 'depthTex', 'prev0', 'prev1', 'prev2', 'prev3'];
      units.forEach((t, i) => {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.uniform1i(loc(accumProgram, names[i]), i);
      });
      gl.uniform3f(loc(accumProgram, 'dirZ'), ...dz);
      gl.uniform3f(loc(accumProgram, 'dirX'), ...dx);
      gl.uniform3f(loc(accumProgram, 'dirY'), ...dy);
      gl.uniform1f(loc(accumProgram, 'invR'), 1 / radius);
      gl.uniform1f(loc(accumProgram, 'texelWorld'), texelWorld);
      gl.uniform1f(loc(accumProgram, 'weight'), weight);
      gl.uniform1i(loc(accumProgram, 'depthRes'), DEPTH_RES);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      read = write;
    }
    gl.depthMask(true);

    const out = new Float32Array(vertexCount * OCCLUSION_SH_COEFFS);
    const buf = new Float32Array(texels * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, accum[read].fb);
    for (let i = 0; i < 4; i++) {
      gl.readBuffer(gl.COLOR_ATTACHMENT0 + i);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, buf);
      for (let v = 0; v < vertexCount; v++) {
        out.set(buf.subarray(v * 4, v * 4 + 4), v * OCCLUSION_SH_COEFFS + i * 4);
      }
    }
    return out;
  } catch (e) {
    console.error('[brdfView] occlusion bake failed', e);
    return null;
  } finally {
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteVertexArray(vao);
    created.textures.forEach((t) => gl.deleteTexture(t));
    created.framebuffers.forEach((f) => gl.deleteFramebuffer(f));
    created.programs.forEach((p) => gl.deleteProgram(p));
    gl.activeTexture(gl.TEXTURE0);
  }
}

type V3 = [number, number, number];

/** Fibonacci-sphere direction k with a pseudo-randomly rotated image basis. */
function directionBasis(k: number): [V3, V3, V3] {
  const y = 1 - (2 * (k + 0.5)) / DIRECTION_COUNT;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const phi = k * Math.PI * (3 - Math.sqrt(5));
  const z: V3 = [Math.cos(phi) * r, y, Math.sin(phi) * r];
  const up: V3 = Math.abs(z[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  let x = normalize(cross(up, z));
  let yy = cross(z, x);
  // rotate the image plane per direction so depth-map texel grids decorrelate
  const a = ((k * 0.7548776662) % 1) * 2 * Math.PI;
  const c = Math.cos(a), s = Math.sin(a);
  const rx: V3 = [x[0] * c + yy[0] * s, x[1] * c + yy[1] * s, x[2] * c + yy[2] * s];
  const ry: V3 = [yy[0] * c - x[0] * s, yy[1] * c - x[1] * s, yy[2] * c - x[2] * s];
  x = rx;
  yy = ry;
  return [z, x, yy];
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

const DEPTH_VERT = `#version 300 es
uniform vec3 dirZ;
uniform vec3 dirX;
uniform vec3 dirY;
uniform float invR;
in vec3 pos;
void main() {
  gl_Position = vec4(dot(pos, dirX) * invR, dot(pos, dirY) * invR, -dot(pos, dirZ) * invR, 1.0);
}
`;

const DEPTH_FRAG = `#version 300 es
precision highp float;
void main() {}
`;

const ACCUM_VERT = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const ACCUM_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D posTex;
uniform sampler2D nrmTex;
uniform highp sampler2D depthTex;
uniform sampler2D prev0;
uniform sampler2D prev1;
uniform sampler2D prev2;
uniform sampler2D prev3;
uniform vec3 dirZ;
uniform vec3 dirX;
uniform vec3 dirY;
uniform float invR;
uniform float texelWorld;
uniform float weight;
uniform int depthRes;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;

void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  o0 = texelFetch(prev0, ip, 0);
  o1 = texelFetch(prev1, ip, 0);
  o2 = texelFetch(prev2, ip, 0);
  o3 = texelFetch(prev3, ip, 0);
  vec3 n = texelFetch(nrmTex, ip, 0).xyz;
  if (dot(n, n) < 1e-12) return; // padding texel
  n = normalize(n);
  float c = dot(n, dirZ);
  if (c <= 0.0) return; // only the vertex hemisphere carries occlusion

  // normal offset + slope-scaled bias against self-shadowing
  vec3 q = texelFetch(posTex, ip, 0).xyz + n * (1.5 * texelWorld);
  vec2 uv = vec2(dot(q, dirX), dot(q, dirY)) * invR * 0.5 + 0.5;
  float d = -dot(q, dirZ) * invR * 0.5 + 0.5;
  float tanT = sqrt(max(1.0 - c * c, 0.0)) / c;
  float bias = texelWorld * (1.0 + min(tanT, 4.0)) * invR * 0.5;

  ivec2 center = ivec2(uv * float(depthRes));
  float occ = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      ivec2 t = clamp(center + ivec2(i, j), ivec2(0), ivec2(depthRes - 1));
      if (d - bias > texelFetch(depthTex, t, 0).r) occ += 1.0;
    }
  }
  occ *= weight / 9.0;
  if (occ <= 0.0) return;

  vec3 v = dirZ;
  float x = v.x, y = v.y, z = v.z;
  o0 += occ * vec4(0.282095, 0.488603 * y, 0.488603 * z, 0.488603 * x);
  o1 += occ * vec4(1.092548 * x * y, 1.092548 * y * z, 0.315392 * (3.0 * z * z - 1.0), 1.092548 * x * z);
  o2 += occ * vec4(0.546274 * (x * x - y * y), 0.590044 * y * (3.0 * x * x - y * y), 2.890611 * x * y * z, 0.457046 * y * (5.0 * z * z - 1.0));
  o3 += occ * vec4(0.373176 * z * (5.0 * z * z - 3.0), 0.457046 * x * (5.0 * z * z - 1.0), 1.445306 * z * (x * x - y * y), 0.590044 * x * (x * x - 3.0 * y * y));
}
`;
