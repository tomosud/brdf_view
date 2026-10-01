// Parameter panel: global plot controls (channel, log plot, N.L, incident
// theta/phi) plus a per-BRDF group. Only the visible BRDF is expanded because
// visibility is exclusive in this port. Rebuilds from the store on change.

import { floatControl, boolControl, colorControl, selectControl } from './controls.js';
import type { Channel, Store } from '../state/store.js';
import type {
  BrdfDef,
  BrdfInstance,
  ParamDef,
  ParamTexture,
  TextureChannel,
  TextureColorSpace,
  TextureImage,
} from '../brdf/types.js';
import { splitCustomImplementationName } from '../brdf/loader.js';
import { defaultColorSpace, loadTextureImage } from '../brdf/param-texture.js';

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
  s.dataset.testid = 'plot-controls';
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
  const index = store.state.brdfs.indexOf(inst);
  s.dataset.testid = `brdf-${index}`;
  s.dataset.brdfIndex = String(index);
  if (inst.def.origin?.kind === 'bundled') s.dataset.brdfFile = inst.def.origin.filename;
  s.dataset.visible = String(inst.visible);
  if (!inst.visible) s.classList.add('brdf-section-collapsed');
  const heading = s.querySelector('h3')!;
  heading.textContent = '';

  const visibleLabel = document.createElement('label');
  visibleLabel.className = 'brdf-visible-toggle';
  const visible = document.createElement('input');
  visible.type = 'checkbox';
  visible.checked = inst.visible;
  visible.dataset.testid = 'brdf-visible';
  visible.setAttribute('aria-label', `Show ${inst.def.name}`);
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
  defaults.dataset.testid = 'brdf-defaults';
  defaults.addEventListener('click', () => store.resetParams(id));

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn-close';
  close.textContent = 'Close';
  close.dataset.testid = 'brdf-close';
  close.addEventListener('click', () => store.removeBrdf(id));

  btnGroup.append(defaults, close);
  heading.append(visibleLabel, btnGroup);

  if (!inst.visible) return s;

  if (isShaderBrdf(inst.def)) s.append(...normalMapRows(store, id, inst));

  for (const p of inst.def.params) {
    const row = paramControl(store, id, inst, p);
    row.dataset.testid = `param-${p.name}`;
    row.dataset.param = p.name;
    s.append(row);
    if (p.kind !== 'bool') {
      onImageDrop(row, async (file) => {
        const img = await loadTextureImage(file, file.name);
        const colorSpace = defaultColorSpace(p.name);
        if (p.kind === 'color') {
          store.setParamTexture(id, p.name, { ...img, channel: 'rgb', colorSpace });
          return;
        }
        const channel = await chooseChannel(row, p.name, img);
        if (channel) store.setParamTexture(id, p.name, { ...img, channel, colorSpace });
        else URL.revokeObjectURL(img.url);
      });
      const tex = inst.textures?.get(p.name);
      if (tex) s.append(textureBadge(store, id, p, tex));
    }
  }
  return s;
}

/** Calls `handle` with an image file dropped on `target` (errors are shown in an alert). */
function onImageDrop(target: HTMLElement, handle: (file: File) => Promise<void>): void {
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  target.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
    target.classList.add('texture-drop-target');
  });
  target.addEventListener('dragleave', () => target.classList.remove('texture-drop-target'));
  target.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    target.classList.remove('texture-drop-target');
    const file = e.dataTransfer!.files[0];
    if (!file) return;
    try {
      await handle(file);
    } catch (err) {
      window.alert((err as Error).message);
    }
  });
}

const CHANNELS: { value: TextureChannel; text: string }[] = [
  { value: 'r', text: 'R' },
  { value: 'g', text: 'G' },
  { value: 'b', text: 'B' },
  { value: 'a', text: 'A' },
];

/** Ask which channel of the dropped image feeds a float parameter. Resolves null on cancel. */
function chooseChannel(anchor: HTMLElement, name: string, img: TextureImage): Promise<TextureChannel | null> {
  document.querySelector('.texture-channel-chooser')?.remove();
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'texture-channel-chooser';
    box.dataset.testid = 'texture-channel-chooser';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', `Channel of ${img.fileName} for ${name}`);
    const title = document.createElement('div');
    title.className = 'texture-channel-title';
    title.textContent = `${name} ← ${img.fileName}: channel`;
    const buttons = document.createElement('div');
    buttons.className = 'texture-channel-buttons';
    const done = (v: TextureChannel | null) => {
      document.removeEventListener('keydown', onKey);
      box.remove();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') done(null);
      const c = CHANNELS.find((x) => x.text === e.key.toUpperCase());
      if (c) done(c.value);
    };
    for (const c of CHANNELS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-compact';
      b.textContent = c.text;
      b.dataset.channel = c.value;
      b.addEventListener('click', () => done(c.value));
      buttons.append(b);
    }
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-compact';
    cancel.textContent = 'Cancel';
    cancel.dataset.channel = 'cancel';
    cancel.addEventListener('click', () => done(null));
    buttons.append(cancel);
    box.append(title, buttons);
    document.body.append(box);
    const r = anchor.getBoundingClientRect();
    box.style.left = `${Math.max(8, r.left)}px`;
    box.style.top = `${Math.min(window.innerHeight - 80, r.bottom + 2)}px`;
    document.addEventListener('keydown', onKey);
    (buttons.firstElementChild as HTMLButtonElement).focus();
  });
}

function textureBadge(store: Store, id: string, p: ParamDef, tex: ParamTexture): HTMLElement {
  const name = p.name;
  const badge = imageBadge(tex, `param-texture-${name}`, `Remove the image from ${name}`, () => store.setParamTexture(id, name, null));
  badge.title = `${name}: ${tex.fileName} (${tex.width}×${tex.height}). Used per pixel in Lit Object; the slider value is still used by the plots.`;
  const controls: HTMLElement[] = [];
  if (p.kind === 'float') {
    controls.push(
      miniSelect('channel', CHANNELS, tex.channel === 'rgb' ? 'r' : tex.channel, (v) =>
        store.setParamTexture(id, name, { ...tex, channel: v as TextureChannel }),
      ),
    );
  }
  controls.push(
    miniSelect(
      'color-space',
      [
        { value: 'srgb', text: 'sRGB' },
        { value: 'linear', text: 'Linear' },
      ],
      tex.colorSpace,
      (v) => store.setParamTexture(id, name, { ...tex, colorSpace: v as TextureColorSpace }),
      'Encoding of the image. Values are converted to what the .brdf expects (color: sRGB like the picker, float: linear).',
    ),
  );
  badge.querySelector('.param-texture-name')!.after(...controls);
  return badge;
}

/** "normal map" drop row (every analytic BRDF) and, when set, its badge. */
function normalMapRows(store: Store, id: string, inst: BrdfInstance): HTMLElement[] {
  const row = document.createElement('div');
  row.className = 'ctl-row normal-map-row';
  row.dataset.testid = 'normal-map';
  row.title = 'Drop a tangent-space normal map here (DirectX / -Y by default; untick DX for OpenGL maps). Used in Lit Object with the mesh UVs.';
  const label = document.createElement('span');
  label.className = 'ctl-label';
  label.textContent = 'normal map';
  const hint = document.createElement('span');
  hint.className = 'normal-map-hint';
  hint.textContent = inst.normalMap ? '' : 'drop image (Lit Object)';
  row.append(label, hint);
  onImageDrop(row, async (file) => {
    const img = await loadTextureImage(file, file.name);
    store.setNormalMap(id, { ...img, flipY: inst.normalMap?.flipY ?? true, strength: inst.normalMap?.strength ?? 1 });
  });
  const nm = inst.normalMap;
  if (!nm) return [row];

  const badge = imageBadge(nm, 'normal-map-badge', 'Remove the normal map', () => store.setNormalMap(id, null));
  badge.title = `normal map: ${nm.fileName} (${nm.width}×${nm.height}). Linear, tangent space.`;
  const flip = document.createElement('label');
  flip.className = 'param-texture-flag';
  flip.title = 'Flip the green channel (DirectX-style normal maps)';
  const flipBox = document.createElement('input');
  flipBox.type = 'checkbox';
  flipBox.checked = nm.flipY;
  flipBox.dataset.testid = 'normal-map-flip-y';
  flipBox.setAttribute('aria-label', 'Flip Y (DirectX)');
  flipBox.addEventListener('change', () => store.setNormalMap(id, { ...nm, flipY: flipBox.checked }));
  flip.append(flipBox, 'DX');
  const strength = document.createElement('input');
  strength.type = 'number';
  strength.className = 'param-texture-strength';
  strength.min = '0';
  strength.max = '4';
  strength.step = '0.1';
  strength.value = String(nm.strength);
  strength.title = 'Normal map strength (scales the tangent-space XY)';
  strength.dataset.testid = 'normal-map-strength';
  strength.setAttribute('aria-label', 'Normal map strength');
  strength.addEventListener('change', () => {
    const v = Number(strength.value);
    if (Number.isFinite(v)) store.setNormalMap(id, { ...nm, strength: Math.max(0, v) });
  });
  badge.querySelector('.param-texture-name')!.after(flip, strength);
  return [row, badge];
}

function imageBadge(img: TextureImage, testid: string, removeTitle: string, onRemove: () => void): HTMLElement {
  const badge = document.createElement('div');
  badge.className = 'param-texture';
  badge.dataset.testid = testid;
  const thumb = document.createElement('img');
  thumb.src = img.url;
  thumb.alt = '';
  const label = document.createElement('span');
  label.className = 'param-texture-name';
  label.textContent = img.fileName;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn btn-compact';
  remove.textContent = '×';
  remove.title = removeTitle;
  remove.setAttribute('aria-label', removeTitle);
  remove.dataset.testid = 'param-texture-remove';
  remove.addEventListener('click', onRemove);
  badge.append(thumb, label, remove);
  return badge;
}

function miniSelect(
  testid: string,
  options: { value: string; text: string }[],
  value: string,
  onChange: (v: string) => void,
  title?: string,
): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'param-texture-select';
  sel.dataset.testid = `param-texture-${testid}`;
  sel.setAttribute('aria-label', testid);
  if (title) sel.title = title;
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.text;
    sel.append(opt);
  }
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

function paramControl(store: Store, id: string, inst: BrdfInstance, p: ParamDef): HTMLElement {
  if (p.kind === 'float') {
    return floatControl(
      p.name,
      Number(inst.values.get(p.name)),
      p.min,
      p.max,
      p.default,
      (v) => store.setParam(id, p.name, v),
      p.description,
    );
  }
  if (p.kind === 'bool') {
    return boolControl(
      parameterDisplayName(p.name),
      Boolean(inst.values.get(p.name)),
      (v) => store.setParam(id, p.name, v),
      p.description,
    );
  }
  return colorControl(
    p.name,
    inst.values.get(p.name) as [number, number, number],
    (v) => store.setParam(id, p.name, v),
    p.description,
  );
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
