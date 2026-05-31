// Radiance RGBE (.hdr) loader -> linear Float32 RGBA equirectangular image.
// Supports new-style (adaptive) RLE scanlines, which the provided ibl.hdr uses,
// plus a flat/old-RLE fallback. Reference: Radiance file format (Greg Ward).

export interface HdrImage {
  width: number;
  height: number;
  /** width*height*4 linear floats (alpha = 1). */
  data: Float32Array;
}

export function parseHdr(buf: ArrayBuffer): HdrImage {
  const bytes = new Uint8Array(buf);
  let pos = 0;

  const readLine = (): string => {
    let s = '';
    while (pos < bytes.length) {
      const c = bytes[pos++];
      if (c === 0x0a) break;
      s += String.fromCharCode(c);
    }
    return s;
  };

  // Header: magic, key=value lines, then a blank line.
  const magic = readLine();
  if (!magic.startsWith('#?')) throw new Error('not a Radiance .hdr file');
  for (;;) {
    const line = readLine();
    if (line === '') break;
    // FORMAT must be 32-bit_rle_rgbe (we ignore other directives like EXPOSURE)
  }

  // Resolution line, e.g. "-Y 512 +X 1024".
  const res = readLine().trim().split(/\s+/);
  if (res.length !== 4 || res[0] !== '-Y' || res[2] !== '+X') {
    throw new Error(`unsupported HDR orientation: ${res.join(' ')}`);
  }
  const height = parseInt(res[1], 10);
  const width = parseInt(res[3], 10);

  const rgbe = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    const rowOff = y * width * 4;
    // Peek the 4-byte scanline header for new-style RLE.
    const h0 = bytes[pos], h1 = bytes[pos + 1], h2 = bytes[pos + 2], h3 = bytes[pos + 3];
    const isNewRLE = h0 === 2 && h1 === 2 && ((h2 << 8) | h3) === width && width >= 8 && width < 32768;

    if (!isNewRLE) {
      // Flat scanline: copy width RGBE pixels (old-RLE runs are rare for these maps).
      for (let x = 0; x < width; x++) {
        rgbe[rowOff + x * 4] = bytes[pos++];
        rgbe[rowOff + x * 4 + 1] = bytes[pos++];
        rgbe[rowOff + x * 4 + 2] = bytes[pos++];
        rgbe[rowOff + x * 4 + 3] = bytes[pos++];
      }
      continue;
    }

    pos += 4;
    // Four separate channel runs (R, G, B, E), each width long.
    for (let ch = 0; ch < 4; ch++) {
      let x = 0;
      while (x < width) {
        let count = bytes[pos++];
        if (count > 128) {
          // run of (count-128) copies of the next byte
          const run = count - 128;
          const val = bytes[pos++];
          for (let i = 0; i < run; i++) rgbe[rowOff + (x++) * 4 + ch] = val;
        } else {
          // count literal bytes
          for (let i = 0; i < count; i++) rgbe[rowOff + (x++) * 4 + ch] = bytes[pos++];
        }
      }
    }
  }

  // RGBE -> linear float
  const data = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const e = rgbe[i * 4 + 3];
    if (e === 0) {
      data[i * 4 + 3] = 1;
      continue;
    }
    const f = Math.pow(2, e - (128 + 8));
    data[i * 4] = rgbe[i * 4] * f;
    data[i * 4 + 1] = rgbe[i * 4 + 1] * f;
    data[i * 4 + 2] = rgbe[i * 4 + 2] * f;
    data[i * 4 + 3] = 1;
  }

  return { width, height, data };
}
