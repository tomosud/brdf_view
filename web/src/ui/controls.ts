// Small DOM control factories. Float = slider + numeric input with Ctrl+click
// reset to default (matching the original's reset affordance), plus bool and
// color controls.

import { clamp01, clampRgb, linearToSrgbRgb, srgbToLinearRgb, type Rgb } from './color-space.js';

export function labeledRow(label: string, control: HTMLElement): HTMLElement {
  const row = document.createElement('label');
  row.className = 'ctl-row';
  const span = document.createElement('span');
  span.className = 'ctl-label';
  span.textContent = label;
  span.title = label;
  row.append(span, control);
  return row;
}

export function floatControl(
  label: string,
  value: number,
  min: number,
  max: number,
  def: number,
  onChange: (v: number) => void,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'ctl-float';
  const sliderStep = 0.1;
  const numberStep = 0.01;
  const round2 = (x: number) => Math.round(x * 100) / 100;
  const format = (x: number) => round2(x).toFixed(2);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(sliderStep);
  slider.value = String(round2(value));

  const num = document.createElement('input');
  num.type = 'number';
  num.min = String(min);
  num.max = String(max);
  num.step = String(numberStep);
  num.value = format(value);

  const set = (v: number, from?: HTMLInputElement, formatNumber = from !== num) => {
    if (!Number.isFinite(v)) return;
    const clamped = round2(Math.max(min, Math.min(max, v)));
    if (from !== slider) slider.value = String(clamped);
    if (from !== num || formatNumber) num.value = format(clamped);
    onChange(clamped);
  };
  slider.addEventListener('input', () => set(Number(slider.value), slider));
  num.addEventListener('input', () => {
    if (num.value.trim() === '') return;
    set(Number(num.value), num, false);
  });
  num.addEventListener('blur', () => set(Number(num.value)));
  // Ctrl+click resets to default.
  slider.addEventListener('pointerdown', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      set(def);
    }
  });

  wrap.append(slider, num);
  return labeledRow(label, wrap);
}

export function boolControl(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = value;
  cb.addEventListener('change', () => onChange(cb.checked));
  return labeledRow(label, cb);
}

export function colorControl(
  label: string,
  value: Rgb,
  onChange: (v: Rgb) => void,
): HTMLElement {
  const committed: Rgb = clampRgb(value);
  let draft: Rgb = [...committed];
  let hsv = rgbToHsv(draft);
  const row = document.createElement('div');
  row.className = 'ctl-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'ctl-label';
  labelEl.textContent = label;
  labelEl.title = label;

  const wrap = document.createElement('div');
  wrap.className = 'ctl-color';

  const swatch = document.createElement('button');
  swatch.type = 'button';
  swatch.className = 'ctl-color-swatch';
  swatch.title = 'Open color picker';

  const popover = document.createElement('div');
  popover.className = 'color-popover';
  popover.hidden = true;

  const sv = document.createElement('div');
  sv.className = 'color-sv';
  const svMarker = document.createElement('div');
  svMarker.className = 'color-marker';
  sv.append(svMarker);

  const hue = document.createElement('input');
  hue.type = 'range';
  hue.className = 'color-hue';
  hue.min = '0';
  hue.max = '360';
  hue.step = '1';

  const fields = document.createElement('div');
  fields.className = 'color-fields';
  const head = document.createElement('div');
  head.className = 'color-channel-head';
  head.append(document.createElement('span'), channelHead('R'), channelHead('G'), channelHead('B'));
  fields.append(head);

  const channels = ['R', 'G', 'B'] as const;
  const srgbInputs = colorInputRow(fields, 'sRGB', channels, 0, 255, 1);
  const linearInputs = colorInputRow(fields, 'Linear', channels, 0, 1, 0.001);

  const actions = document.createElement('div');
  actions.className = 'color-actions';
  const pick = document.createElement('button');
  pick.type = 'button';
  pick.className = 'btn btn-compact color-pick-button';
  pick.title = 'Pick screen color';
  pick.innerHTML = [
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">',
    '<path d="M10.9 1.7l3.4 3.4-1.4 1.4-.9-.9-5.6 5.6-2.5.7.7-2.5 5.6-5.6-.9-.9 1.6-1.2z"/>',
    '</svg>',
  ].join('');
  const eyeDropper = (window as Window & {
    EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> };
  }).EyeDropper;
  if (!eyeDropper) {
    pick.disabled = true;
    pick.title = 'Screen color picker unavailable';
  }

  const actionRight = document.createElement('div');
  actionRight.className = 'color-action-right';
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'btn btn-compact';
  apply.textContent = 'Apply';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-compact';
  cancel.textContent = 'Cancel';
  actionRight.append(apply, cancel);
  actions.append(pick, actionRight);

  const hidePopover = () => {
    popover.hidden = true;
    popover.remove();
  };

  const showPopover = () => {
    document.body.append(popover);
    popover.hidden = false;
    setDraft(draft);
    const swatchRect = swatch.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(swatchRect.left, window.innerWidth - popRect.width - margin));
    const below = swatchRect.bottom + 4;
    const above = swatchRect.top - popRect.height - 4;
    const top = below + popRect.height + margin <= window.innerHeight ? below : Math.max(margin, above);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  };

  const setDraft = (next: [number, number, number], updateHsv = true, commitPreview = false) => {
    draft = clampRgb(next);
    const linear = srgbToLinearRgb(draft);
    if (updateHsv) hsv = rgbToHsv(draft);
    const hex = rgbToHex(draft);
    swatch.style.backgroundColor = hex;
    sv.style.backgroundColor = hsvToCss(hsv.h, 1, 1);
    hue.value = String(Math.round(hsv.h));
    svMarker.style.left = `${hsv.s * 100}%`;
    svMarker.style.top = `${(1 - hsv.v) * 100}%`;
    for (let i = 0; i < 3; i++) {
      srgbInputs[i].value = String(clamp255(draft[i]));
      linearInputs[i].value = formatLinear(linear[i]);
    }
    apply.disabled = sameColor(draft, committed);
    if (commitPreview) onChange([...draft]);
  };

  const setFromSv = (clientX: number, clientY: number) => {
    const rect = sv.getBoundingClientRect();
    hsv.s = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    hsv.v = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    setDraft(hsvToRgb(hsv.h, hsv.s, hsv.v), false, true);
  };

  sv.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    sv.setPointerCapture(e.pointerId);
    setFromSv(e.clientX, e.clientY);
  });
  sv.addEventListener('pointermove', (e) => {
    if (e.buttons) setFromSv(e.clientX, e.clientY);
  });
  hue.addEventListener('input', () => {
    hsv.h = Number(hue.value);
    setDraft(hsvToRgb(hsv.h, hsv.s, hsv.v), false, true);
  });
  srgbInputs.forEach((input, i) => {
    input.addEventListener('input', () => {
      const next: Rgb = [...draft];
      next[i] = Math.max(0, Math.min(1, Number(input.value) / 255 || 0));
      setDraft(next, true, true);
    });
  });
  linearInputs.forEach((input, i) => {
    input.addEventListener('input', () => {
      const next = srgbToLinearRgb(draft);
      next[i] = Math.max(0, Math.min(1, Number(input.value) || 0));
      setDraft(linearToSrgbRgb(next), true, true);
    });
  });

  pick.addEventListener('click', async () => {
    if (!eyeDropper) return;
    try {
      const picked = await new eyeDropper().open();
      setDraft(hexToSrgb(picked.sRGBHex), true, true);
    } catch {
      // User cancellation is expected; keep the current draft.
    }
  });

  apply.addEventListener('click', () => {
    hidePopover();
  });
  cancel.addEventListener('click', () => {
    setDraft(committed, true, true);
    hidePopover();
  });
  swatch.addEventListener('click', () => {
    if (popover.isConnected && !popover.hidden) hidePopover();
    else showPopover();
  });

  popover.append(sv, hue, fields, actions);
  wrap.append(swatch);
  row.append(labelEl, wrap);
  setDraft(draft);
  return row;
}

function channelHead(name: string): HTMLElement {
  const span = document.createElement('span');
  span.textContent = name;
  return span;
}

function colorInputRow(
  root: HTMLElement,
  label: string,
  channels: readonly string[],
  min: number,
  max: number,
  step: number,
): HTMLInputElement[] {
  const row = document.createElement('div');
  row.className = 'color-field-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'color-space-label';
  labelEl.textContent = label;
  row.append(labelEl);
  const inputs = channels.map((name) => {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.title = `${label} ${name}`;
    row.append(input);
    return input;
  });
  root.append(row);
  return inputs;
}

export function selectControl(
  label: string,
  options: { value: string; text: string }[],
  value: string,
  onChange: (v: string) => void,
): HTMLElement {
  const sel = document.createElement('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.text;
    sel.append(opt);
  }
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  return labeledRow(label, sel);
}

function clamp255(x: number): number {
  return Math.max(0, Math.min(255, Math.round(x * 255)));
}
function rgbToHex(c: Rgb): string {
  return '#' + [c[0], c[1], c[2]].map((v) => clamp255(v).toString(16).padStart(2, '0')).join('');
}
function hexToSrgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function formatLinear(x: number): string {
  return clamp01(x).toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0');
}
function sameColor(a: Rgb, b: Rgb): boolean {
  return Math.abs(a[0] - b[0]) < 0.0001 && Math.abs(a[1] - b[1]) < 0.0001 && Math.abs(a[2] - b[2]) < 0.0001;
}

function rgbToHsv([r, g, b]: Rgb): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function hsvToRgb(h: number, s: number, v: number): Rgb {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (h < 60) [rp, gp, bp] = [c, x, 0];
  else if (h < 120) [rp, gp, bp] = [x, c, 0];
  else if (h < 180) [rp, gp, bp] = [0, c, x];
  else if (h < 240) [rp, gp, bp] = [0, x, c];
  else if (h < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  return [rp + m, gp + m, bp + m];
}

function hsvToCss(h: number, s: number, v: number): string {
  return rgbToHex(hsvToRgb(h, s, v));
}

