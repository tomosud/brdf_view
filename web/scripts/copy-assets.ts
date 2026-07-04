/**
 * Copies runtime assets from the original Disney BRDF Explorer source tree
 * (`sample/brdf-main`, which is gitignored) into `web/public/` so they are
 * served statically and committed alongside the web app.
 *
 * Resilient by design: if the source tree is absent (e.g. on CI, where
 * sample/brdf-main is not checked in), it logs and exits 0, relying on the
 * already-committed copies under public/.
 *
 * NOTE: shaderTemplates under public/ are hand-ported to GLSL ES 3.00 and are
 * authored directly in this repo — they are NOT copied from the source.
 */
import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { parseHdr, type HdrImage } from '../src/io/hdr.js';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const repoRoot = join(webRoot, '..');
const srcRoot = join(repoRoot, 'sample', 'brdf-main');
const publicRoot = join(webRoot, 'public');

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function copyIfChanged(from: string, to: string): boolean {
  if (existsSync(to)) {
    const fromStat = statSync(from);
    const toStat = statSync(to);
    if (fromStat.size === toStat.size && readFileSync(from).equals(readFileSync(to))) {
      return false;
    }
  }
  copyFileSync(from, to);
  return true;
}

function copyByExt(fromDir: string, toDir: string, exts: string[]): number {
  if (!existsSync(fromDir)) return 0;
  ensureDir(toDir);
  let n = 0;
  for (const name of readdirSync(fromDir)) {
    const from = join(fromDir, name);
    if (!statSync(from).isFile()) continue;
    if (!exts.some((e) => name.toLowerCase().endsWith(e))) continue;
    if (copyIfChanged(from, join(toDir, name))) n++;
  }
  return n;
}

function listByExt(dir: string, exts: string[]): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isFile())
    .filter((name) => exts.some((e) => name.toLowerCase().endsWith(e)))
    .sort((a, b) => a.localeCompare(b));
}

function writeManifest(dir: string, fileName: string, names: string[]): void {
  ensureDir(dir);
  writeFileSync(join(dir, fileName), `${JSON.stringify(names, null, 2)}\n`, 'utf8');
}

function writeIfChanged(path: string, data: Buffer | string): boolean {
  const next = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  if (existsSync(path) && readFileSync(path).equals(next)) return false;
  writeFileSync(path, next);
  return true;
}

function copyFiles(fromDir: string, toDir: string, names: string[]): number {
  ensureDir(toDir);
  let n = 0;
  for (const name of names) {
    const from = join(fromDir, name);
    if (existsSync(from)) {
      if (copyIfChanged(from, join(toDir, name))) n++;
    }
  }
  return n;
}

function hdrArrayBuffer(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function thumbnailName(name: string): string {
  return name.replace(/\.[^.]+$/u, '.png');
}

function generateEnvironmentThumbnails(fromDir: string, toDir: string): number {
  const names = listByExt(fromDir, ['.hdr']);
  ensureDir(toDir);
  let n = 0;
  const manifest: Record<string, string> = {};
  for (const name of names) {
    try {
      const pngName = thumbnailName(name);
      const image = parseHdr(hdrArrayBuffer(join(fromDir, name)));
      const png = encodePng(renderHdrThumbnail(image, 192, 96), 192, 96);
      if (writeIfChanged(join(toDir, pngName), png)) n++;
      manifest[name] = pngName;
    } catch (e) {
      console.warn(`[copy-assets] failed to generate environment thumbnail for ${name}: ${(e as Error).message}`);
    }
  }
  writeIfChanged(join(toDir, 'index.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return n;
}

function renderHdrThumbnail(image: HdrImage, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const exposure = thumbnailExposure(image);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(image.height - 1, Math.floor(((y + 0.5) / height) * image.height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.floor(((x + 0.5) / width) * image.width));
      const src = (sy * image.width + sx) * 4;
      const dst = (y * width + x) * 4;
      out[dst] = toSrgb8(image.data[src] * exposure);
      out[dst + 1] = toSrgb8(image.data[src + 1] * exposure);
      out[dst + 2] = toSrgb8(image.data[src + 2] * exposure);
      out[dst + 3] = 255;
    }
  }
  return out;
}

function thumbnailExposure(image: HdrImage): number {
  const lums: number[] = [];
  const step = Math.max(1, Math.floor(Math.sqrt((image.width * image.height) / 12000)));
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const i = (y * image.width + x) * 4;
      lums.push(0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2]);
    }
  }
  lums.sort((a, b) => a - b);
  const p90 = lums[Math.max(0, Math.min(lums.length - 1, Math.floor(lums.length * 0.9)))] ?? 1;
  return 1.2 / Math.max(0.001, p90);
}

function toSrgb8(linear: number): number {
  const mapped = 1 - Math.exp(-Math.max(0, linear));
  const srgb = mapped <= 0.0031308 ? mapped * 12.92 : 1.055 * Math.pow(mapped, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(srgb * 255)));
}

function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    scanlines[row] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(scanlines, row + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr(width, height)),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function ihdr(width: number, height: number): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  data[10] = 0;
  data[11] = 0;
  data[12] = 0;
  return data;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBuf.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 8 + data.length);
  return out;
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < CRC_TABLE.length; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

let brdfs = 0;
let licenses = 0;

if (existsSync(srcRoot)) {
  brdfs = copyByExt(join(srcRoot, 'src', 'brdfs'), join(publicRoot, 'brdfs'), ['.brdf']);
  licenses = copyFiles(srcRoot, publicRoot, ['LICENSE', 'LICENSE-BINARY', 'README']);
} else {
  console.warn(`[copy-assets] source tree not found at ${srcRoot}; using committed public/ assets.`);
}

// Project-local sample BRDFs are intentionally tracked under sample/brdf and
// override/augment the public sample list.
brdfs += copyByExt(join(repoRoot, 'sample', 'brdf'), join(publicRoot, 'brdfs'), ['.brdf']);

// Large measured-BRDF samples and the default IBL environment live outside the
// original source tree (sample/brdf, assets/). These are gitignored under
// public/ (too large / licensed data) and used for local dev + the sample button.
const measured = copyByExt(join(repoRoot, 'sample', 'brdf'), join(publicRoot, 'measured'), ['.binary']);
const envs = copyByExt(join(repoRoot, 'assets'), join(publicRoot, 'environments'), ['.hdr', '.exr']);
const envThumbs = generateEnvironmentThumbnails(join(repoRoot, 'assets'), join(publicRoot, 'environment-thumbs'));
const objs = copyByExt(join(repoRoot, 'assets', 'obj'), join(publicRoot, 'obj'), ['.obj']);

writeManifest(join(publicRoot, 'brdfs'), 'index.json', listByExt(join(publicRoot, 'brdfs'), ['.brdf']));
writeManifest(join(publicRoot, 'environments'), 'index.json', listByExt(join(publicRoot, 'environments'), ['.hdr', '.exr']));
writeManifest(join(publicRoot, 'obj'), 'index.json', listByExt(join(publicRoot, 'obj'), ['.obj']));

console.log(
  `[copy-assets] copied ${brdfs} .brdf, ${licenses} license/readme, ${measured} measured .binary, ${envs} environment, ${envThumbs} environment thumbnail, ${objs} obj file(s).`,
);
