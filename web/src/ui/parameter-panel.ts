// Parameter panel: global plot controls (channel, log plot, N.L, incident
// theta/phi) plus a per-BRDF group. Only the visible BRDF is expanded because
// visibility is exclusive in this port. Rebuilds from the store on change.

import { floatControl, boolControl, colorControl, selectControl } from './controls.js';
import type { Channel, Store } from '../state/store.js';
import type { BrdfDef } from '../brdf/types.js';
import { splitCustomImplementationName } from '../brdf/loader.js';

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
  if (isShaderBrdf(inst.def)) {
    const sourceIcon = document.createElement('button');
    sourceIcon.type = 'button';
    sourceIcon.className = 'brdf-source-icon';
    sourceIcon.title = 'Open .brdf source';
    sourceIcon.setAttribute('aria-label', 'GLSL .brdf shader file');
    sourceIcon.addEventListener('click', (e) => {
      e.preventDefault();
      void openBrdfSource(inst.def, sourceIcon);
    });
    visibleLabel.append(visible, sourceIcon);
  } else {
    visibleLabel.append(visible);
  }
  const title = document.createElement('span');
  title.className = 'brdf-title';
  const customTitle = splitCustomImplementationName(inst.def.name);
  if (customTitle) {
    const name = document.createElement('span');
    name.className = 'brdf-title-name';
    name.textContent = customTitle.name;
    const badge = document.createElement('span');
    badge.className = 'brdf-title-badge';
    badge.textContent = customTitle.badge;
    title.append(name, badge);
  } else {
    title.textContent = inst.def.name;
  }
  visibleLabel.append(title);

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
        floatControl(
          p.name,
          Number(inst.values.get(p.name)),
          p.min,
          p.max,
          p.default,
          (v) => store.setParam(id, p.name, v),
          p.description,
        ),
      );
    } else if (p.kind === 'bool') {
      s.append(
        boolControl(
          parameterDisplayName(p.name),
          Boolean(inst.values.get(p.name)),
          (v) => store.setParam(id, p.name, v),
          p.description,
        ),
      );
    } else {
      s.append(
        colorControl(
          p.name,
          inst.values.get(p.name) as [number, number, number],
          (v) => store.setParam(id, p.name, v),
          p.description,
        ),
      );
    }
  }
  return s;
}

function parameterDisplayName(name: string): string {
  if (name === 'second_roughness_as_clearcoat_custom') {
    return 'second_roughness_as_clearcoat（custom）';
  }
  return name;
}

function isShaderBrdf(def: BrdfDef): boolean {
  return !def.measured;
}

async function openBrdfSource(def: BrdfDef, trigger: HTMLButtonElement): Promise<void> {
  trigger.disabled = true;
  try {
    const source = await loadBrdfSource(def);
    showSourceModal(source.name, source.filename, source.text);
  } catch (e) {
    console.error('Failed to open .brdf source', e);
    window.alert('Failed to open .brdf source.');
  } finally {
    trigger.disabled = false;
  }
}

async function loadBrdfSource(def: BrdfDef): Promise<{ name: string; filename: string; text: string }> {
  const origin = def.origin;
  if (origin?.kind === 'bundled') {
    const res = await fetch(`${import.meta.env.BASE_URL}brdfs/${origin.filename}`);
    if (!res.ok) throw new Error(`failed to fetch ${origin.filename}: ${res.status}`);
    return { name: def.name, filename: origin.filename, text: await res.text() };
  }
  if (origin?.kind === 'text') {
    return { name: origin.name || def.name, filename: sourceFilename(origin.name || def.name), text: origin.content };
  }
  return { name: def.name, filename: sourceFilename(def.name), text: reconstructBrdfSource(def) };
}

function showSourceModal(title: string, filename: string, text: string): void {
  document.querySelector('.source-modal-backdrop')?.remove();

  const backdrop = document.createElement('div');
  backdrop.className = 'source-modal-backdrop';
  const dialog = document.createElement('div');
  dialog.className = 'source-modal';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', `${filename} source`);

  const header = document.createElement('div');
  header.className = 'source-modal-header';
  const heading = document.createElement('div');
  heading.className = 'source-modal-title';
  heading.textContent = title;
  heading.title = title;

  const actions = document.createElement('div');
  actions.className = 'source-modal-actions';
  const copy = sourceActionButton('Copy');
  const download = sourceActionButton('Download');
  const close = sourceActionButton('Close');

  copy.addEventListener('click', () => {
    void copyText(text).then(() => {
      copy.textContent = 'Copied';
      window.setTimeout(() => {
        copy.textContent = 'Copy';
      }, 900);
    });
  });
  download.addEventListener('click', () => downloadText(filename, text));

  const closeModal = () => {
    document.removeEventListener('keydown', onKeyDown);
    backdrop.remove();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeModal();
  };
  close.addEventListener('click', closeModal);
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop) closeModal();
  });
  document.addEventListener('keydown', onKeyDown);

  actions.append(copy, download, close);
  header.append(heading, actions);

  const editor = document.createElement('div');
  editor.className = 'source-editor';
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const row = document.createElement('div');
    row.className = 'source-line';
    const number = document.createElement('span');
    number.className = 'source-line-number';
    number.textContent = String(i + 1);
    const code = document.createElement('span');
    code.className = 'source-line-code';
    code.textContent = line || ' ';
    row.append(number, code);
    editor.append(row);
  });

  dialog.append(header, editor);
  backdrop.append(dialog);
  document.body.append(backdrop);
  close.focus();
}

function sourceActionButton(label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-compact source-action';
  button.textContent = label;
  return button;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.append(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function sourceFilename(name: string): string {
  return /\.brdf$/i.test(name) ? name : `${name}.brdf`;
}

function reconstructBrdfSource(def: BrdfDef): string {
  const params = def.params.map((p) => {
    const comment = p.description ? `  # ${p.description}` : '';
    if (p.kind === 'float') return `float ${p.name} ${p.min} ${p.max} ${p.default}${comment}`;
    if (p.kind === 'bool') return `bool ${p.name} ${p.default ? 1 : 0}${comment}`;
    return `color ${p.name} ${p.default[0]} ${p.default[1]} ${p.default[2]}${comment}`;
  });
  const chunks = [
    'analytic',
    '',
    '::begin parameters',
    ...params,
    '::end parameters',
    '',
    '::begin shader',
    def.shaderSource,
    '::end shader',
  ];
  if (def.isFuncSource) {
    chunks.push('', '::begin isFunc', def.isFuncSource, '::end isFunc');
  }
  return chunks.join('\n');
}
