// App entry: feature-detect WebGL2, load the seed BRDFs, wire the store to the
// parameter panel and the 3D view.

import './style.css';
import { detectFeatures } from './gl/renderer.js';
import { Store } from './state/store.js';
import { loadBundledBrdf } from './brdf/loader.js';
import { loadBrdfFile, loadMeasuredFromUrl } from './io/file-open.js';
import { mountParameterPanel } from './ui/parameter-panel.js';
import { Plot3DView } from './views/plot-3d.js';
import { LitSphereView } from './views/lit-sphere.js';
import { LitObjectView } from './views/lit-object.js';
import { ImageSliceView } from './views/image-slice.js';
import { parseHdr } from './io/hdr.js';
import { PlotPolarView } from './views/plot-polar.js';
import { PlotCartesianView } from './views/plot-cartesian.js';

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
  const log = document.createElement('pre');
  log.id = 'shader-log';
  log.setAttribute('hidden', '');
  views.append(log);

  new Plot3DView(views, store);
  new PlotPolarView(views, store);
  new PlotCartesianView(views, store);
  new LitSphereView(views, store);
  new ImageSliceView(views, store);

  // Lit Object (IBL) — needs the equirect HDRI environment.
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}environments/ibl.hdr`);
    if (res.ok) {
      new LitObjectView(views, store, parseHdr(await res.arrayBuffer()));
    } else {
      console.warn('IBL environment not found; Lit Object view skipped.');
    }
  } catch (e) {
    console.error('IBL environment load failed', e);
  }

  wireFileLoading(store, views);

  // Seed with lambert and disney.
  for (const file of ['lambert.brdf', 'disney.brdf']) {
    try {
      const inst = await loadBundledBrdf(file);
      if (file !== 'lambert.brdf') inst.visible = false; // start with one visible
      store.addBrdf(inst);
    } catch (e) {
      console.error(e);
    }
  }
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

  document.getElementById('load-sample-merl')!.addEventListener('click', async () => {
    try {
      const url = `${import.meta.env.BASE_URL}measured/gold-metallic-paint3.binary`;
      store.addBrdf(await loadMeasuredFromUrl(url, 'gold-metallic-paint3'));
    } catch (e) {
      fatal(`Sample MERL not available: ${(e as Error).message}`);
      setTimeout(() => document.getElementById('fatal')!.setAttribute('hidden', ''), 4000);
    }
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

main();
