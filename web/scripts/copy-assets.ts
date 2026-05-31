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
import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const repoRoot = join(webRoot, '..');
const srcRoot = join(repoRoot, 'sample', 'brdf-main');
const publicRoot = join(webRoot, 'public');

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function copyByExt(fromDir: string, toDir: string, exts: string[]): number {
  if (!existsSync(fromDir)) return 0;
  ensureDir(toDir);
  let n = 0;
  for (const name of readdirSync(fromDir)) {
    const from = join(fromDir, name);
    if (!statSync(from).isFile()) continue;
    if (!exts.some((e) => name.toLowerCase().endsWith(e))) continue;
    copyFileSync(from, join(toDir, name));
    n++;
  }
  return n;
}

function copyFiles(fromDir: string, toDir: string, names: string[]): number {
  ensureDir(toDir);
  let n = 0;
  for (const name of names) {
    const from = join(fromDir, name);
    if (existsSync(from)) {
      copyFileSync(from, join(toDir, name));
      n++;
    }
  }
  return n;
}

if (!existsSync(srcRoot)) {
  console.warn(`[copy-assets] source tree not found at ${srcRoot}; using committed public/ assets.`);
  process.exit(0);
}

const brdfs = copyByExt(join(srcRoot, 'src', 'brdfs'), join(publicRoot, 'brdfs'), ['.brdf']);
const licenses = copyFiles(srcRoot, publicRoot, ['LICENSE', 'LICENSE-BINARY', 'README']);

console.log(`[copy-assets] copied ${brdfs} .brdf file(s), ${licenses} license/readme file(s).`);
