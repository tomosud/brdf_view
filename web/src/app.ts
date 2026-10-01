// App entry: feature-detect WebGL2, load the seed BRDFs, wire the store to the
// parameter panel and the 3D view.

import './style.css';
import { detectFeatures } from './gl/renderer.js';
import { Store } from './state/store.js';
import { bundledBrdfDisplayName, loadBundledBrdf } from './brdf/loader.js';
import { loadBrdfFile } from './io/file-open.js';
import { mountParameterPanel } from './ui/parameter-panel.js';
import { Plot3DView } from './views/plot-3d.js';
import { LitSphereView } from './views/lit-sphere.js';
import { LitObjectView } from './views/lit-object.js';
import { ImageSliceView } from './views/image-slice.js';
import { parseHdr } from './io/hdr.js';
import { PlotPolarView } from './views/plot-polar.js';
import { PlotCartesianView } from './views/plot-cartesian.js';
import { scheduleSave, restoreSession, restoreImages } from './state/persist.js';
import { installApi } from './api/index.js';
import { applyState, stateFromLocation, type ViewMap } from './api/state.js';
import { mountStateTools } from './ui/state-tools.js';
import { mountToneMapToggle } from './ui/tone-map-toggle.js';
import { startUrlSync } from './ui/url-sync.js';
import type { BaseView } from './views/base-view.js';

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
  const viewMap: ViewMap = {};
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  installApi(store, viewMap, ready);
  mountStateTools(document.getElementById('toolbar')!);
  mountToneMapToggle(document.getElementById('toolbar')!, store);
  mountParameterPanel(document.getElementById('parameter-panel')!, store);

  const views = document.getElementById('views')!;
  const viewRows = mountViewRows(views);
  const log = document.createElement('pre');
  log.id = 'shader-log';
  log.setAttribute('hidden', '');
  views.append(log);

  const addView = (v: BaseView) => {
    viewMap[v.key] = v;
  };
  addView(new Plot3DView(viewRows.top, store));
  addView(new PlotPolarView(viewRows.top, store));
  addView(new PlotCartesianView(viewRows.top, store));
  addView(new ImageSliceView(viewRows.bottom, store));

  // Lit Object (IBL) — needs the equirect HDRI environment.
  try {
    const envNames = prioritize(await fetchJson<string[]>(`${import.meta.env.BASE_URL}environments/index.json`).catch(() => ['ibl.hdr']), 'ibl.hdr');
    const envThumbs = await fetchJson<Record<string, string>>(`${import.meta.env.BASE_URL}environment-thumbs/index.json`).catch(() => ({}));
    const objNames = await fetchJson<string[]>(`${import.meta.env.BASE_URL}obj/index.json`).catch(() => []);
    const res = await fetch(`${import.meta.env.BASE_URL}environments/${envNames[0]}`);
    if (res.ok) {
      addView(new LitObjectView(viewRows.bottom, store, parseHdr(await res.arrayBuffer()), envNames, objNames, envThumbs));
    } else {
      console.warn('IBL environment not found; Lit Object view skipped.');
    }
  } catch (e) {
    console.error('IBL environment load failed', e);
  }
  addView(new LitSphereView(viewRows.bottom, store));
  mountColumnSplitters(viewRows.top, 'top');
  mountColumnSplitters(viewRows.bottom, 'bottom');

  wireFileLoading(store, views);
  void wireSampleBrdfs(store);
  wireColResizer();

  // A state link (#v=1&...) wins over the saved session; otherwise restore the
  // previous session from IndexedDB, and fall back to seeding defaults.
  const linkState = await stateFromLocation(location).catch((e) => {
    console.warn('Could not read the state in the URL', e);
    return null;
  });
  let restored = false;
  if (linkState) {
    const warnings = await applyState(store, viewMap, linkState);
    for (const w of warnings) console.warn(`[brdfView] ${w}`);
    restored = store.state.brdfs.length > 0;
    // Images are not in links; bring back the ones saved for the same BRDFs.
    await restoreImages(store);
  } else {
    restored = await restoreSession(store);
  }
  if (!restored) {
    for (const file of ['lambert.brdf', 'unreal_legacy_pbr.brdf', 'openpbr.brdf', 'substrate.brdf']) {
      try {
        store.addBrdf(await loadBundledBrdf(file), false);
      } catch (e) {
        console.error(e);
      }
    }
  }

  // Whether seeded or restored, make sure something renders: if no BRDF is
  // visible, enable the bottom-most entry in the list.
  const brdfs = store.state.brdfs;
  if (brdfs.length && !brdfs.some((b) => b.visible)) {
    store.setVisible(brdfs[brdfs.length - 1].id, true);
  }

  // Begin persisting after initial load to avoid saving during restore.
  store.subscribe(() => scheduleSave(store));

  await Promise.all(Object.values(viewMap).map((v) => v.ready.catch(() => undefined)));
  markReady();
  startUrlSync(store, viewMap);
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
  splitter.title = 'Drag to resize the view rows (double-click: reset)';
  splitter.dataset.testid = 'view-row-resizer';
  views.append(top, splitter, bottom);

  // Either row can be shrunk down to its title bars, so one row can take almost all the height.
  const saved = Number(localStorage.getItem(ROW_SIZE_KEY));
  if (saved > 0 && saved < 100) views.style.setProperty('--top-row-size', `${saved}%`);

  splitter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const rect = views.getBoundingClientRect();
      const min = MIN_ROW_PX / rect.height;
      const ratio = Math.max(min, Math.min(1 - min, (ev.clientY - rect.top) / rect.height));
      views.style.setProperty('--top-row-size', `${ratio * 100}%`);
      localStorage.setItem(ROW_SIZE_KEY, String(ratio * 100));
    };
    const up = (ev: PointerEvent) => {
      splitter.releasePointerCapture(ev.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  splitter.addEventListener('dblclick', () => {
    views.style.removeProperty('--top-row-size');
    localStorage.removeItem(ROW_SIZE_KEY);
  });

  return { top, bottom };
}

const ROW_SIZE_KEY = 'viewTopRowSize';
/** Smallest height of a view row / width of a view while dragging a splitter (about a title bar). */
const MIN_ROW_PX = 40;
const MIN_VIEW_PX = 48;

/**
 * Put a draggable splitter between the views of one row, so that a view (e.g.
 * Lit Object) can be made wider at the expense of its neighbour. Widths are kept
 * as weights (fr), saved in localStorage; double-click a splitter to reset the row.
 * Call once all views of the row exist.
 */
function mountColumnSplitters(row: HTMLElement, key: string): void {
  const viewEls = Array.from(row.querySelectorAll<HTMLElement>(':scope > .view'));
  if (viewEls.length < 2) return;
  const storageKey = `viewColumns.${key}`;
  let weights = viewEls.map(() => 1);
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (Array.isArray(saved) && saved.length === weights.length && saved.every((w) => typeof w === 'number' && w > 0)) weights = saved;
  } catch {
    // ignore a corrupt entry
  }
  const apply = () => {
    row.style.columnGap = '0';
    row.style.gridTemplateColumns = weights.map((w) => `minmax(0, ${w}fr)`).join(' 8px ');
  };
  apply();

  viewEls.slice(0, -1).forEach((left, i) => {
    const right = viewEls[i + 1];
    const splitter = document.createElement('div');
    splitter.className = 'view-col-resizer';
    splitter.setAttribute('role', 'separator');
    splitter.setAttribute('aria-orientation', 'vertical');
    splitter.title = 'Drag to resize the views (double-click: reset)';
    splitter.dataset.testid = `view-col-resizer-${key}-${i}`;
    left.after(splitter);

    splitter.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      splitter.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const a = left.getBoundingClientRect().width;
      const b = right.getBoundingClientRect().width;
      const pair = weights[i] + weights[i + 1];
      const move = (ev: PointerEvent) => {
        const min = Math.min(MIN_VIEW_PX, (a + b) / 2);
        const na = Math.max(min, Math.min(a + b - min, a + ev.clientX - startX));
        weights[i] = (pair * na) / (a + b);
        weights[i + 1] = pair - weights[i];
        apply();
        localStorage.setItem(storageKey, JSON.stringify(weights));
      };
      const up = (ev: PointerEvent) => {
        splitter.releasePointerCapture(ev.pointerId);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    splitter.addEventListener('dblclick', () => {
      weights = viewEls.map(() => 1);
      apply();
      localStorage.removeItem(storageKey);
    });
  });
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
        opt.textContent = bundledBrdfDisplayName(name);
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
