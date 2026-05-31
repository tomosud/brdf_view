// App entry: feature-detect WebGL2, load the seed BRDFs, wire the store to the
// parameter panel and the 3D view.

import './style.css';
import { detectFeatures } from './gl/renderer.js';
import { Store } from './state/store.js';
import { loadBundledBrdf } from './brdf/loader.js';
import { mountParameterPanel } from './ui/parameter-panel.js';
import { Plot3DView } from './views/plot-3d.js';
import { LitSphereView } from './views/lit-sphere.js';
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

main();
