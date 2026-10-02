// Minimal OpenEXR writer: scanline image, R/G/B as 32-bit float, ZIP compression
// (16 scanlines per chunk, zlib through the browser's CompressionStream).
// Reference: "OpenEXR File Layout" (openexr.com) and the predictor / reorder step
// of OpenEXR's ImfZip.cpp.

/** `rgba`: width * height * 4 floats, rows top to bottom; alpha is not written. */
export async function encodeExr(width: number, height: number, rgba: Float32Array): Promise<Blob> {
  const header = buildHeader(width, height);
  const linesPerChunk = 16;
  const chunkCount = Math.ceil(height / linesPerChunk);
  const chunks: Uint8Array[] = [];
  for (let c = 0; c < chunkCount; c++) {
    const y0 = c * linesPerChunk;
    const lines = Math.min(linesPerChunk, height - y0);
    const raw = new Uint8Array(lines * width * 3 * 4);
    const view = new DataView(raw.buffer);
    let o = 0;
    for (let y = y0; y < y0 + lines; y++) {
      // channels in the header's (alphabetical) order: B, G, R
      for (const ch of [2, 1, 0]) {
        for (let x = 0; x < width; x++, o += 4) view.setFloat32(o, rgba[(y * width + x) * 4 + ch], true);
      }
    }
    const packed = await zlib(predict(raw));
    // A chunk that does not get smaller is stored uncompressed (readers check the size).
    const data = packed.length < raw.length ? packed : raw;
    const chunk = new Uint8Array(8 + data.length);
    const cv = new DataView(chunk.buffer);
    cv.setInt32(0, y0, true);
    cv.setInt32(4, data.length, true);
    chunk.set(data, 8);
    chunks.push(chunk);
  }

  const offsets = new Uint8Array(chunkCount * 8);
  const ov = new DataView(offsets.buffer);
  let pos = header.length + offsets.length;
  chunks.forEach((chunk, i) => {
    ov.setBigUint64(i * 8, BigInt(pos), true);
    pos += chunk.length;
  });
  return new Blob([header, offsets, ...chunks] as BlobPart[], { type: 'image/x-exr' });
}

function buildHeader(width: number, height: number): Uint8Array {
  const out: number[] = [];
  const bytes = (b: ArrayLike<number>) => {
    for (let i = 0; i < b.length; i++) out.push(b[i]);
  };
  const str = (s: string) => bytes([...new TextEncoder().encode(s), 0]);
  const i32 = (...v: number[]) => {
    const b = new DataView(new ArrayBuffer(4 * v.length));
    v.forEach((x, i) => b.setInt32(i * 4, x, true));
    bytes(new Uint8Array(b.buffer));
  };
  const f32 = (...v: number[]) => {
    const b = new DataView(new ArrayBuffer(4 * v.length));
    v.forEach((x, i) => b.setFloat32(i * 4, x, true));
    bytes(new Uint8Array(b.buffer));
  };
  const attr = (name: string, type: string, size: number, value: () => void) => {
    str(name);
    str(type);
    i32(size);
    const before = out.length;
    value();
    if (out.length - before !== size) throw new Error(`exr: attribute ${name} size`);
  };

  i32(20000630, 2); // magic, version 2 (scanline, short names)
  const channels = ['B', 'G', 'R'];
  attr('channels', 'chlist', channels.length * 18 + 1, () => {
    for (const c of channels) {
      str(c);
      i32(2); // FLOAT
      bytes([0, 0, 0, 0]); // pLinear, reserved
      i32(1, 1); // x / y sampling
    }
    bytes([0]);
  });
  attr('compression', 'compression', 1, () => bytes([3])); // ZIP_COMPRESSION (16 lines)
  attr('dataWindow', 'box2i', 16, () => i32(0, 0, width - 1, height - 1));
  attr('displayWindow', 'box2i', 16, () => i32(0, 0, width - 1, height - 1));
  attr('lineOrder', 'lineOrder', 1, () => bytes([0])); // INCREASING_Y
  attr('pixelAspectRatio', 'float', 4, () => f32(1));
  attr('screenWindowCenter', 'v2f', 8, () => f32(0, 0));
  attr('screenWindowWidth', 'float', 4, () => f32(1));
  // Rec.709 / sRGB primaries, D65 white
  attr('chromaticities', 'chromaticities', 32, () => f32(0.64, 0.33, 0.3, 0.6, 0.15, 0.06, 0.3127, 0.329));
  bytes([0]); // end of header
  return new Uint8Array(out);
}

/** OpenEXR ZIP pre-pass: split even / odd bytes into two halves, then byte deltas. */
function predict(raw: Uint8Array): Uint8Array {
  const t = new Uint8Array(raw.length);
  const half = (raw.length + 1) >> 1;
  for (let i = 0, a = 0, b = half; i < raw.length; i += 2) {
    t[a++] = raw[i];
    if (i + 1 < raw.length) t[b++] = raw[i + 1];
  }
  let p = t[0];
  for (let i = 1; i < t.length; i++) {
    const d = (t[i] - p + 128 + 256) & 0xff;
    p = t[i];
    t[i] = d;
  }
  return t;
}

async function zlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
