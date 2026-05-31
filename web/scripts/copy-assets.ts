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
import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync, writeFileSync } from 'node:fs';
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
const objs = copyByExt(join(repoRoot, 'assets', 'obj'), join(publicRoot, 'obj'), ['.obj']);

writeManifest(join(publicRoot, 'brdfs'), 'index.json', listByExt(join(publicRoot, 'brdfs'), ['.brdf']));
writeManifest(join(publicRoot, 'environments'), 'index.json', listByExt(join(publicRoot, 'environments'), ['.hdr', '.exr']));
writeManifest(join(publicRoot, 'obj'), 'index.json', listByExt(join(publicRoot, 'obj'), ['.obj']));

console.log(
  `[copy-assets] copied ${brdfs} .brdf, ${licenses} license/readme, ${measured} measured .binary, ${envs} environment, ${objs} obj file(s).`,
);
