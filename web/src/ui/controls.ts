// Small DOM control factories. Float = slider + numeric input with Ctrl+click
// reset to default (matching the original's reset affordance), plus bool and
// color controls.

export function labeledRow(label: string, control: HTMLElement): HTMLElement {
  const row = document.createElement('label');
  row.className = 'ctl-row';
  const span = document.createElement('span');
  span.className = 'ctl-label';
  span.textContent = label;
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
  const step = (max - min) / 1000 || 0.001;

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(value);

  const num = document.createElement('input');
  num.type = 'number';
  num.min = String(min);
  num.max = String(max);
  num.step = String(step);
  num.value = String(value);

  const set = (v: number, from?: HTMLInputElement) => {
    const clamped = Math.max(min, Math.min(max, v));
    if (from !== slider) slider.value = String(clamped);
    if (from !== num) num.value = String(clamped);
    onChange(clamped);
  };
  slider.addEventListener('input', () => set(Number(slider.value), slider));
  num.addEventListener('input', () => set(Number(num.value), num));
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
  value: [number, number, number],
  onChange: (v: [number, number, number]) => void,
): HTMLElement {
  const input = document.createElement('input');
  input.type = 'color';
  input.value = rgbToHex(value);
  input.addEventListener('input', () => onChange(hexToRgb(input.value)));
  return labeledRow(label, input);
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
function rgbToHex(c: [number, number, number]): string {
  return '#' + [c[0], c[1], c[2]].map((v) => clamp255(v).toString(16).padStart(2, '0')).join('');
}
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
