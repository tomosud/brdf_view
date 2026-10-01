#!/usr/bin/env node
// Headless capture for BRDF Explorer Web: opens the app in Playwright Chromium,
// applies a state, and saves PNG renders, numeric data and evaluations through
// window.brdfView. Usage reference: docs/ai_control.md (or --help).
//
//   node web/scripts/capture.mjs --state state.json --view litObject --out out.png
//   node web/scripts/capture.mjs --url "<shared link>" --view slice --out s.png --data s.csv
//   node web/scripts/capture.mjs --batch jobs.json

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, createReadStream } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `BRDF Explorer Web capture (Playwright)

Usage: node web/scripts/capture.mjs [options]
       capture.bat [options]                      (Windows, from the repo root)

State (applied in this order, each optional):
  --url <link>           Shared link; only its #v=1&... (or ?v=1&...) part is used
  --state <file.json>    State JSON (window.brdfView.getState() format, partial allowed)
  --brdf <file>          Load only this bundled .brdf (e.g. callisto_brdf.brdf)
  --set <name=value>     Set a parameter of the visible BRDF (repeatable; color: r,g,b)
  --light <theta[,phi]>  Incident light angles in degrees
  --opt <key=value>      Any state key in link form, e.g. litObject.exposure=-1 (repeatable)

Outputs:
  --view <name>          View to render: litObject, litSphere, slice, polar, cartesian,
                         plot3d, or "page" (whole window). Repeatable / comma list.
  --out <file.png>       PNG path. With several views, "{view}" in the name is replaced
                         (otherwise _<view> is appended).
  --width <px>           Render width  (default 512; page: viewport width, default 1600)
  --height <px>          Render height (default 512; page: viewport height, default 1000)
  --frames <n>           IBL accumulation passes for litObject (default 512 = converged)
  --data <file>          exportData of --data-view (default: first data view in --view,
                         else slice). .csv writes CSV, anything else JSON.
  --data-view <name>     slice, polar, cartesian or plot3d
  --resolution <n>       Samples per axis for --data
  --eval <file.json>     Evaluate samples: [{L,V,N?,X?,Y?} | {thetaL,phiL,thetaV,phiV}, ...]
                         or {"samples": [...], "brdf": ..., "params": {...}}
  --eval-out <file>      Where to write the evaluation JSON (default: stdout)
  --save-state <file>    Write the resolved state JSON
  --print-link           Print the shareable link of the resolved state

Batch:
  --batch <jobs.json>    {"defaults": {...}, "jobs": [{...}, ...]} or a plain array. Job keys
                         are the long option names (url, state, brdf, set, light, opt, view,
                         out, width, height, frames, data, dataView, resolution, eval,
                         evalOut, saveState, printLink). "state" may be an object. Paths are
                         relative to the batch file. One browser for all jobs.

Server (default: start Vite in-process from web/, no build needed):
  --dist                 Serve web/dist (run "npm run build" first) at /brdf_view/
  --base <url>           Use a running app instead (e.g. http://localhost:5173/)
  --headed               Show the browser window
  --help
`;

const { values: args } = parseArgs({
  options: {
    url: { type: 'string' },
    state: { type: 'string' },
    brdf: { type: 'string' },
    set: { type: 'string', multiple: true },
    light: { type: 'string' },
    opt: { type: 'string', multiple: true },
    view: { type: 'string', multiple: true },
    out: { type: 'string' },
    width: { type: 'string' },
    height: { type: 'string' },
    frames: { type: 'string' },
    data: { type: 'string' },
    'data-view': { type: 'string' },
    resolution: { type: 'string' },
    eval: { type: 'string' },
    'eval-out': { type: 'string' },
    'save-state': { type: 'string' },
    'print-link': { type: 'boolean' },
    batch: { type: 'string' },
    dist: { type: 'boolean' },
    base: { type: 'string' },
    headed: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: false,
});

if (args.help || process.argv.length <= 2) {
  process.stdout.write(HELP);
  process.exit(0);
}

const DATA_VIEWS = ['slice', 'polar', 'cartesian', 'plot3d'];

function log(msg) {
  process.stderr.write(`[capture] ${msg}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
}

function ensureParent(path) {
  mkdirSync(dirname(path), { recursive: true });
}

/** Normalize CLI options or a batch job into one job object with absolute paths. */
function normalizeJob(job, baseDir) {
  const abs = (p) => (p === undefined || p === null || p === '' ? undefined : resolve(baseDir, String(p)));
  const list = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const views = list(job.view).flatMap((v) => String(v).split(',')).map((v) => v.trim()).filter(Boolean);
  let state = job.state;
  if (typeof state === 'string') state = readJson(abs(state));
  let set = job.set;
  if (set && !Array.isArray(set) && typeof set === 'object') set = Object.entries(set).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`);
  let opt = job.opt;
  if (opt && !Array.isArray(opt) && typeof opt === 'object') opt = Object.entries(opt).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`);
  let evalSpec = job.eval;
  if (typeof evalSpec === 'string') evalSpec = readJson(abs(evalSpec));
  const num = (v) => (v === undefined ? undefined : Number(v));
  return {
    url: job.url,
    state,
    brdf: job.brdf,
    set: list(set).map(String),
    light: job.light === undefined ? undefined : Array.isArray(job.light) ? job.light.map(Number) : String(job.light).split(',').map(Number),
    opt: list(opt).map(String),
    views,
    out: abs(job.out),
    width: num(job.width),
    height: num(job.height),
    frames: num(job.frames),
    data: abs(job.data),
    dataView: job.dataView ?? job['data-view'],
    resolution: num(job.resolution),
    eval: evalSpec,
    evalOut: abs(job.evalOut ?? job['eval-out']),
    saveState: abs(job.saveState ?? job['save-state']),
    printLink: Boolean(job.printLink ?? job['print-link']),
  };
}

function outPathFor(out, view, many) {
  if (out.includes('{view}')) return out.replaceAll('{view}', view);
  if (!many) return out;
  const ext = extname(out) || '.png';
  return `${out.slice(0, out.length - extname(out).length)}_${view}${ext}`;
}

/** The "#v=1&..." part of a link, or a bare "v=1&..." string. */
function linkParams(url) {
  if (!url) return 'v=1';
  const t = String(url).trim();
  const h = t.indexOf('#');
  if (h >= 0) return t.slice(h + 1);
  const q = t.indexOf('?');
  return q >= 0 ? t.slice(q + 1) : t;
}

// ---------------------------------------------------------------------------
// Server

async function startServer() {
  if (args.base) return { url: args.base.endsWith('/') ? args.base : `${args.base}/`, close: async () => {} };
  if (args.dist) return startDistServer();
  return startViteServer();
}

async function startViteServer() {
  // Same as `npm run dev`: refresh public/ (sample .brdf etc.) first.
  const tsxCli = join(webDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const r = spawnSync(process.execPath, [tsxCli, 'scripts/copy-assets.ts'], { cwd: webDir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`copy-assets failed:\n${r.stdout}\n${r.stderr}`);
  const { createServer } = await import('vite');
  const server = await createServer({
    root: webDir,
    configFile: join(webDir, 'vite.config.ts'),
    logLevel: 'warn',
    clearScreen: false,
    server: { host: '127.0.0.1', port: 5190, strictPort: false, open: false },
  });
  await server.listen();
  const url = server.resolvedUrls?.local?.[0] ?? 'http://127.0.0.1:5190/';
  return { url, close: () => server.close() };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

async function startDistServer() {
  const root = join(webDir, 'dist');
  if (!existsSync(join(root, 'index.html'))) throw new Error('web/dist not found; run "npm run build" in web/ first');
  const prefix = '/brdf_view/';
  const server = createHttpServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!path.startsWith(prefix)) {
      res.writeHead(302, { Location: prefix });
      res.end();
      return;
    }
    let file = resolve(root, `.${sep}${path.slice(prefix.length)}`);
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}${prefix}`, close: () => new Promise((ok) => server.close(ok)) };
}

// ---------------------------------------------------------------------------
// Browser

async function launchBrowser() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('playwright is not installed; run "npm ci" in web/');
  }
  // Prefer the real GPU (ANGLE) for speed; Chromium falls back to SwiftShader.
  const gpuArgs = process.platform === 'win32' ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--enable-gpu', '--ignore-gpu-blocklist'];
  try {
    return await chromium.launch({ headless: !args.headed, args: gpuArgs });
  } catch (e) {
    throw new Error(`${e.message}\nIf the browser is missing, run: cd web && npx playwright install chromium`);
  }
}

async function openApp(context, baseUrl, params) {
  const page = await context.newPage();
  page.on('console', (m) => {
    const t = m.type();
    const text = m.text();
    if (t === 'error' || (t === 'warning' && text.startsWith('[brdfView]'))) log(`page ${t}: ${text}`);
  });
  page.on('pageerror', (e) => log(`page error: ${e.message}`));
  await page.goto(`${baseUrl}#${params}`);
  try {
    await page.waitForFunction(() => window.brdfView || !document.getElementById('fatal')?.hidden, null, { timeout: 60000 });
  } catch {
    throw new Error('app did not start within 60 s');
  }
  const fatal = await page.evaluate(() => (window.brdfView ? '' : document.getElementById('fatal')?.textContent ?? 'unknown'));
  if (fatal) throw new Error(`app failed to start: ${fatal}`);
  await page.evaluate(() => window.brdfView.ready);
  return page;
}

async function runJob(context, baseUrl, job, index, total) {
  const label = total > 1 ? `job ${index + 1}/${total}: ` : '';
  const page = await openApp(context, baseUrl, linkParams(job.url));
  try {
    const setState = async (s) => {
      const { warnings } = await page.evaluate((st) => window.brdfView.setState(st), s);
      for (const w of warnings) log(`${label}warning: ${w}`);
    };
    if (job.state) await setState(job.state);
    if (job.brdf) await setState({ brdfs: [{ file: job.brdf, visible: true }] });
    for (const kv of job.set) {
      const eq = kv.indexOf('=');
      if (eq < 0) throw new Error(`--set expects name=value, got "${kv}"`);
      await page.evaluate(([n, v]) => window.brdfView.setParam(n, v), [kv.slice(0, eq), kv.slice(eq + 1)]);
    }
    if (job.light) await setState({ light: { theta: job.light[0], ...(job.light.length > 1 ? { phi: job.light[1] } : {}) } });
    if (job.opt.length) await setState(`v=1&${job.opt.map((kv) => kv.split('=').map(encodeURIComponent).join('=')).join('&')}`);

    if (job.views.length && !job.out) throw new Error('--view needs --out');
    for (const view of job.views) {
      const path = outPathFor(job.out, view, job.views.length > 1);
      ensureParent(path);
      if (view === 'page') {
        await page.setViewportSize({ width: job.width ?? 1600, height: job.height ?? 1000 });
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        await page.screenshot({ path });
      } else {
        const t0 = Date.now();
        const dataUrl = await page.evaluate(
          ([v, o]) => window.brdfView.render(v, o),
          [view, { width: job.width ?? 512, height: job.height ?? 512, frames: job.frames }],
        );
        writeFileSync(path, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
        log(`${label}${view} -> ${path} (${Date.now() - t0} ms)`);
        continue;
      }
      log(`${label}${view} -> ${path}`);
    }

    if (job.data) {
      const dataView = job.dataView ?? job.views.find((v) => DATA_VIEWS.includes(v)) ?? 'slice';
      const format = extname(job.data).toLowerCase() === '.csv' ? 'csv' : 'json';
      const data = await page.evaluate(([v, o]) => window.brdfView.exportData(v, o), [dataView, { format, resolution: job.resolution }]);
      ensureParent(job.data);
      writeFileSync(job.data, typeof data === 'string' ? data : `${JSON.stringify(data, null, 1)}\n`);
      log(`${label}data (${dataView}) -> ${job.data}`);
    }

    if (job.eval) {
      const spec = Array.isArray(job.eval) ? { samples: job.eval } : job.eval;
      const result = await page.evaluate(
        ([s]) => window.brdfView.evaluate(s.samples, { brdf: s.brdf, params: s.params }),
        [spec],
      );
      const text = `${JSON.stringify({ samples: spec.samples, rgb: result }, null, 1)}\n`;
      if (job.evalOut) {
        ensureParent(job.evalOut);
        writeFileSync(job.evalOut, text);
        log(`${label}eval (${result.length} samples) -> ${job.evalOut}`);
      } else {
        process.stdout.write(text);
      }
    }

    if (job.saveState) {
      const state = await page.evaluate(() => window.brdfView.getState());
      ensureParent(job.saveState);
      writeFileSync(job.saveState, `${JSON.stringify(state, null, 2)}\n`);
      log(`${label}state -> ${job.saveState}`);
    }
    if (job.printLink) process.stdout.write(`${await page.evaluate(() => window.brdfView.getLink())}\n`);

    const errors = await page.evaluate(() => window.brdfView.errors());
    for (const e of errors) log(`${label}shader error: ${e}`);
    return errors.length === 0;
  } finally {
    await page.close();
  }
}

async function main() {
  let jobs;
  if (args.batch) {
    const batchPath = resolve(args.batch);
    const spec = readJson(batchPath);
    const list = Array.isArray(spec) ? spec : spec.jobs ?? [];
    const defaults = Array.isArray(spec) ? {} : spec.defaults ?? {};
    jobs = list.map((j) => normalizeJob({ ...defaults, ...j }, dirname(batchPath)));
  } else {
    jobs = [normalizeJob({ ...args, dataView: args['data-view'] }, process.cwd())];
  }

  const server = await startServer();
  log(`app: ${server.url}`);
  const browser = await launchBrowser();
  let ok = true;
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const probe = await openApp(context, server.url, 'v=1');
    const renderer = await probe.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER) ?? 'none';
    });
    await probe.close();
    log(`WebGL renderer: ${renderer}`);
    for (let i = 0; i < jobs.length; i++) {
      try {
        ok = (await runJob(context, server.url, jobs[i], i, jobs.length)) && ok;
      } catch (e) {
        ok = false;
        log(`${jobs.length > 1 ? `job ${i + 1}: ` : ''}failed: ${e.message}`);
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  log(e.message ?? String(e));
  process.exit(1);
});
