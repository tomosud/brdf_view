// Parameter panel: global plot controls (channel, log plot, N.L, incident
// theta/phi) plus a per-BRDF group. Only the visible BRDF is expanded because
// visibility is exclusive in this port. Rebuilds from the store on change.

import { floatControl, boolControl, colorControl, selectControl } from './controls.js';
import type { Channel, Store } from '../state/store.js';

export function mountParameterPanel(root: HTMLElement, store: Store): void {
  const render = () => {
    root.replaceChildren();
    root.append(globalSection(store), ...store.state.brdfs.map((b) => brdfSection(store, b.id)));
  };
  store.subscribe(render);
  render();
}

function section(title: string): HTMLElement {
  const s = document.createElement('div');
  s.className = 'panel-section';
  const h = document.createElement('h3');
  h.textContent = title;
  s.append(h);
  return s;
}

function globalSection(store: Store): HTMLElement {
  const s = section('Plot');
  const st = store.state;

  s.append(
    selectControl(
      'Channel',
      [
        { value: 'red', text: 'Red Channel' },
        { value: 'green', text: 'Green Channel' },
        { value: 'blue', text: 'Blue Channel' },
        { value: 'luminance', text: 'Luminance' },
      ],
      st.channel,
      (v) => store.patch({ channel: v as Channel }),
    ),
    boolControl('Log plot', st.useLogPlot, (v) => store.patch({ useLogPlot: v })),
    boolControl('Multiply by N·L', st.useNDotL, (v) => store.patch({ useNDotL: v })),
    floatControl('Incident θ', st.incidentTheta, 0, Math.PI / 2, 0.785398163, (v) =>
      store.patch({ incidentTheta: v }),
    ),
    floatControl('Incident φ', st.incidentPhi, -Math.PI, Math.PI, 0.785398163, (v) =>
      store.patch({ incidentPhi: v }),
    ),
  );
  return s;
}

function brdfSection(store: Store, id: string): HTMLElement {
  const inst = store.state.brdfs.find((b) => b.id === id)!;
  const s = section(inst.def.name);
  s.classList.add('brdf-section');
  if (!inst.visible) s.classList.add('brdf-section-collapsed');
  const heading = s.querySelector('h3')!;
  heading.textContent = '';

  const visibleLabel = document.createElement('label');
  visibleLabel.className = 'brdf-visible-toggle';
  const visible = document.createElement('input');
  visible.type = 'checkbox';
  visible.checked = inst.visible;
  visible.addEventListener('change', () => store.setVisible(id, visible.checked));
  const title = document.createElement('span');
  title.textContent = inst.def.name;
  visibleLabel.append(visible, title);

  const btnGroup = document.createElement('div');
  btnGroup.className = 'brdf-btn-group';

  const defaults = document.createElement('button');
  defaults.type = 'button';
  defaults.className = 'btn btn-close';
  defaults.textContent = 'Defaults';
  defaults.title = 'Reset all parameters to their default values';
  defaults.addEventListener('click', () => store.resetParams(id));

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn-close';
  close.textContent = 'Close';
  close.addEventListener('click', () => store.removeBrdf(id));

  btnGroup.append(defaults, close);
  heading.append(visibleLabel, btnGroup);

  if (!inst.visible) return s;

  for (const p of inst.def.params) {
    if (p.kind === 'float') {
      s.append(
        floatControl(p.name, Number(inst.values.get(p.name)), p.min, p.max, p.default, (v) =>
          store.setParam(id, p.name, v),
        ),
      );
    } else if (p.kind === 'bool') {
      s.append(
        boolControl(p.name, Boolean(inst.values.get(p.name)), (v) => store.setParam(id, p.name, v)),
      );
    } else {
      s.append(
        colorControl(p.name, inst.values.get(p.name) as [number, number, number], (v) =>
          store.setParam(id, p.name, v),
        ),
      );
    }
  }
  return s;
}
