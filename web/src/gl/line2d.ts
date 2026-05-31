// Thin colored 2D lines under an orthographic projection, for plot guides
// (axes, horizon, incident/reflection vectors, semicircle). Not miter-thick —
// guides are drawn as plain GL_LINES/GL_LINE_STRIP.

import { buildProgram, Uniforms } from './renderer.js';
import type { Mat4 } from './mat4.js';

const VERT = `#version 300 es
uniform mat4 projectionMatrix;
in vec2 vtx_position;
in vec3 vtx_color;
out vec3 v_color;
void main() {
  v_color = vtx_color;
  gl_Position = projectionMatrix * vec4(vtx_position, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 v_color;
out vec4 fragColor;
void main() { fragColor = vec4(v_color, 1.0); }`;

export class Line2D {
  private program: WebGLProgram;
  private u: Uniforms;
  private posLoc: number;
  private colLoc: number;
  private posVBO: WebGLBuffer;
  private colVBO: WebGLBuffer;

  constructor(private gl: WebGL2RenderingContext) {
    this.program = buildProgram(gl, VERT, FRAG, 'line2d');
    this.u = new Uniforms(gl, this.program);
    this.posLoc = gl.getAttribLocation(this.program, 'vtx_position');
    this.colLoc = gl.getAttribLocation(this.program, 'vtx_color');
    this.posVBO = gl.createBuffer()!;
    this.colVBO = gl.createBuffer()!;
  }

  /** positions: xy pairs; colors: rgb per vertex; mode: gl.LINES / LINE_STRIP / LINE_LOOP. */
  draw(proj: Mat4, positions: Float32Array, colors: Float32Array, mode: number): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    this.u.m4('projectionMatrix', proj);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posVBO);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.posLoc);
    gl.vertexAttribPointer(this.posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colVBO);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.colLoc);
    gl.vertexAttribPointer(this.colLoc, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(mode, 0, positions.length / 2);
  }
}
