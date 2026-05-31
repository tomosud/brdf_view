// Parameter panel: global plot controls (channel, log plot, N.L, incident
// theta/phi) plus a per-BRDF group with visible/solo/solo-colors and the
// BRDF's own float/bool/color parameters. Rebuilds from the store on change.

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
  const heading = s.querySelector('h3')!;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn-close';
  close.textContent = 'Close';
  close.addEventListener('click', () => store.removeBrdf(id));
  heading.append(close);
  const st = store.state;

  s.append(
    boolControl('Visible', inst.visible, (v) => store.setVisible(id, v)),
    boolControl('Solo', st.soloId === id, (v) => store.patch({ soloId: v ? id : null })),
    boolControl('Solo RGB channels', st.soloColors, (v) => store.patch({ soloColors: v })),
  );

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
