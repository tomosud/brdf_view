// App entry: feature-detect WebGL2, load the seed BRDFs, wire the store to the
// parameter panel and the 3D view.

import './style.css';
import { detectFeatures } from './gl/renderer.js';
import { Store } from './state/store.js';
import { loadBundledBrdf } from './brdf/loader.js';
import { loadBrdfFile } from './io/file-open.js';
import { mountParameterPanel } from './ui/parameter-panel.js';
import { Plot3DView } from './views/plot-3d.js';
import { LitSphereView } from './views/lit-sphere.js';
import { LitObjectView } from './views/lit-object.js';
import { ImageSliceView } from './views/image-slice.js';
import { parseHdr } from './io/hdr.js';
import { PlotPolarView } from './views/plot-polar.js';
import { PlotCartesianView } from './views/plot-cartesian.js';
import { scheduleSave, restoreSession } from './state/persist.js';
import { loadMerlCatalog, loadMerlMaterial, type MerlMaterial } from './io/merl-catalog.js';

function fatal(message: string): void {
  const el = document.getElementById('fatal')!;
  el.removeAttribute('hidden');
  el.textContent = message;
  console.error(message);
}

function checkFeatures(): boolean {
  const probe = document.createElement('canvas').getContext('webgl2');
  if (!probe) {
    fatal('WebGL2 is required but not available in this browser.');
    return false;
  }
  const report = detectFeatures(probe);
  if (!report.ok) {
    fatal(`Required WebGL2 features missing: ${report.missing.join(', ')}`);
    return false;
  }
  return true;
}

async function main(): Promise<void> {
  if (!checkFeatures()) return;

  const store = new Store();
  mountParameterPanel(document.getElementById('parameter-panel')!, store);

  const views = document.getElementById('views')!;
  const viewRows = mountViewRows(views);
  const log = document.createElement('pre');
  log.id = 'shader-log';
  log.setAttribute('hidden', '');
  views.append(log);

  new Plot3DView(viewRows.top, store);
  new PlotPolarView(viewRows.top, store);
  new PlotCartesianView(viewRows.top, store);
  new ImageSliceView(viewRows.bottom, store);

  // Lit Object (IBL) — needs the equirect HDRI environment.
  try {
    const envNames = prioritize(await fetchJson<string[]>(`${import.meta.env.BASE_URL}environments/index.json`).catch(() => ['ibl.hdr']), 'ibl.hdr');
    const objNames = await fetchJson<string[]>(`${import.meta.env.BASE_URL}obj/index.json`).catch(() => []);
    const res = await fetch(`${import.meta.env.BASE_URL}environments/${envNames[0]}`);
    if (res.ok) {
      new LitObjectView(viewRows.bottom, store, parseHdr(await res.arrayBuffer()), envNames, objNames);
    } else {
      console.warn('IBL environment not found; Lit Object view skipped.');
    }
  } catch (e) {
    console.error('IBL environment load failed', e);
  }
  new LitSphereView(viewRows.bottom, store);

  wireFileLoading(store, views);
  void wireMerlLoading(store);
  void wireSampleBrdfs(store);
  wireColResizer();

  // Restore previous session from IndexedDB; fall back to seeding defaults.
  const restored = await restoreSession(store);
  if (!restored) {
    for (const file of ['lambert.brdf', 'disney.brdf']) {
      try {
        const inst = await loadBundledBrdf(file);
        if (file !== 'lambert.brdf') inst.visible = false;
        store.addBrdf(inst, inst.visible);
      } catch (e) {
        console.error(e);
      }
    }
  }

  // Begin persisting after initial load to avoid saving during restore.
  store.subscribe(() => scheduleSave(store));
}

function mountViewRows(views: HTMLElement): { top: HTMLElement; bottom: HTMLElement } {
  const top = document.createElement('div');
  top.className = 'view-row';
  const splitter = document.createElement('div');
  splitter.id = 'row-resizer';
  splitter.setAttribute('role', 'separator');
  splitter.setAttribute('aria-orientation', 'horizontal');
  splitter.title = 'Resize view rows';
  const bottom = document.createElement('div');
  bottom.className = 'view-row';
  views.append(top, splitter, bottom);

  splitter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const rect = views.getBoundingClientRect();
      const ratio = Math.max(0.25, Math.min(0.78, (ev.clientY - rect.top) / rect.height));
      views.style.setProperty('--top-row-size', `${ratio * 100}%`);
    };
    const up = (ev: PointerEvent) => {
      splitter.releasePointerCapture(ev.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  return { top, bottom };
}

function wireColResizer(): void {
  const app = document.getElementById('app')!;
  const resizer = document.getElementById('col-resizer')!;

  // Restore saved width from localStorage.
  const saved = localStorage.getItem('sidebarWidth');
  if (saved) app.style.setProperty('--sidebar-width', `${saved}px`);

  resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const rect = app.getBoundingClientRect();
      const width = Math.max(180, Math.min(700, ev.clientX - rect.left));
      app.style.setProperty('--sidebar-width', `${width}px`);
      localStorage.setItem('sidebarWidth', String(width));
    };
    const up = (ev: PointerEvent) => {
      resizer.releasePointerCapture(ev.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

function wireFileLoading(store: Store, dropTarget: HTMLElement): void {
  const addFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      try {
        store.addBrdf(await loadBrdfFile(f));
      } catch (e) {
        fatal(`Could not load ${f.name}: ${(e as Error).message}`);
        setTimeout(() => document.getElementById('fatal')!.setAttribute('hidden', ''), 4000);
      }
    }
  };

  const input = document.getElementById('file-input') as HTMLInputElement;
  input.addEventListener('change', () => {
    if (input.files) void addFiles(input.files);
    input.value = '';
  });

  // Drag-and-drop onto the views area.
  dropTarget.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropTarget.classList.add('drag-over');
  });
  dropTarget.addEventListener('dragleave', () => dropTarget.classList.remove('drag-over'));
  dropTarget.addEventListener('drop', (e) => {
    e.preventDefault();
    dropTarget.classList.remove('drag-over');
    if (e.dataTransfer?.files.length) void addFiles(e.dataTransfer.files);
  });
}

async function wireSampleBrdfs(store: Store): Promise<void> {
  const button = document.getElementById('load-sample-brdf') as HTMLButtonElement;
  const select = document.getElementById('sample-brdf-select') as HTMLSelectElement;

  try {
    const names = await fetchJson<string[]>(`${import.meta.env.BASE_URL}brdfs/index.json`);
    select.replaceChildren(
      ...names.map((name) => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name.replace(/\.brdf$/i, '');
        return opt;
      }),
    );
  } catch (e) {
    console.warn('Sample BRDF manifest not available', e);
  }

  const loadSelected = async () => {
    if (!select.value) return;
    try {
      store.addBrdf(await loadBundledBrdf(select.value));
    } catch (e) {
      fatal(`Could not load ${select.value}: ${(e as Error).message}`);
      setTimeout(() => document.getElementById('fatal')!.setAttribute('hidden', ''), 4000);
    }
  };

  button.addEventListener('click', () => {
    if (select.hidden) {
      select.hidden = false;
      if (!select.value && select.options.length) select.selectedIndex = 0;
      select.focus();
      return;
    }
    void loadSelected();
  });
  select.addEventListener('change', () => void loadSelected());
}

async function wireMerlLoading(store: Store): Promise<void> {
  const button = document.getElementById('load-merl') as HTMLButtonElement;
  const select = document.getElementById('merl-select') as HTMLSelectElement;
  const byName = new Map<string, MerlMaterial>();

  try {
    const catalog = await loadMerlCatalog();
    const materials = [...catalog.materials].sort((a, b) => a.name.localeCompare(b.name));
    for (const material of materials) byName.set(material.name, material);
    select.replaceChildren(
      ...materials.map((material) => {
        const opt = document.createElement('option');
        opt.value = material.name;
        opt.textContent = material.name;
        return opt;
      }),
    );
  } catch (e) {
    console.warn('MERL material catalog not available', e);
    button.disabled = true;
    button.title = 'MERL catalog not available';
  }

  const loadSelected = async () => {
    const material = byName.get(select.value);
    if (!material) return;
    const label = button.textContent ?? 'Load MERL';
    button.disabled = true;
    button.textContent = 'Loading...';
    try {
      store.addBrdf(await loadMerlMaterial(material));
    } catch (e) {
      fatal(`Could not load ${material.name}: ${(e as Error).message}`);
      setTimeout(() => document.getElementById('fatal')!.setAttribute('hidden', ''), 4000);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  };

  button.addEventListener('click', () => {
    if (select.hidden) {
      select.hidden = false;
      if (!select.value && select.options.length) select.selectedIndex = 0;
      select.focus();
      return;
    }
    void loadSelected();
  });
  select.addEventListener('change', () => void loadSelected());
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

function prioritize(names: string[], first: string): string[] {
  return [...names].sort((a, b) => {
    if (a === first) return -1;
    if (b === first) return 1;
    return a.localeCompare(b);
  });
}

main();
