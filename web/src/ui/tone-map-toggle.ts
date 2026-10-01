// Toolbar checks for the display transform of Lit Object, Lit Sphere and Image
// Slice: "Tone map (ACES 2.0)" (store.state.toneMap / display.toneMap) and
// "HDR" (store.state.hdr / display.hdr). See src/gl/tonemap.ts.

import type { AppState, Store } from '../state/store.js';
import { hdrCanvasSupported, hdrDisplayActive, HDR_PEAK_NITS, HDR_SDR_WHITE_NITS, onHdrDisplayChange } from '../gl/tonemap.js';

export function mountToneMapToggle(toolbar: HTMLElement, store: Store): void {
  const toneMap = toolbarCheck(
    store,
    'toneMap',
    'Tone map (ACES 2.0)',
    'ctl-tone-map',
    'ACES 2.0 のトーンマップで表示する（SDR: 100 nits・Rec.709・sRGB、HDR: 1000 nits・P3-D65）。Lit Object / Lit Sphere / Image Slice に効く。オンの間は Gamma を使わない / ' +
      'Display Lit Object, Lit Sphere and Image Slice through the ACES 2.0 output transform (SDR: 100 nits Rec.709 sRGB, HDR: 1000 nits P3-D65). Gamma is unused while on.',
  );
  const hdr = toolbarCheck(store, 'hdr', 'HDR', 'ctl-hdr', '');
  const hdrInput = hdr.querySelector('input')!;
  const updateHdr = () => {
    const supported = hdrCanvasSupported();
    const active = hdrDisplayActive();
    hdrInput.disabled = !supported;
    hdr.classList.toggle('toolbar-check-inactive', supported && store.state.hdr && !active);
    hdr.title = !supported
      ? 'このブラウザは WebGL の HDR 出力（drawingBufferStorage）に対応していない / This browser cannot output HDR from WebGL.'
      : `HDR で表示する（1.0 = SDR の白 = ${HDR_SDR_WHITE_NITS} nits、Tone map オンなら ACES 2.0 の ${HDR_PEAK_NITS} nits 版）。` +
        `HDR 表示でないモニターでは SDR で表示する。今のモニター: ${active ? 'HDR' : 'SDR'}。撮影（PNG）は常に SDR / ` +
        `Show HDR (1.0 = SDR white = ${HDR_SDR_WHITE_NITS} nits; with Tone map, ACES 2.0 ${HDR_PEAK_NITS} nits). ` +
        `Falls back to SDR on an SDR display. Current display: ${active ? 'HDR' : 'SDR'}. Captures (PNG) stay SDR.`;
  };
  updateHdr();
  store.subscribe(updateHdr);
  // Moving the window between SDR and HDR displays changes the output.
  onHdrDisplayChange(() => {
    updateHdr();
    store.emit();
  });
  toolbar.append(toneMap, hdr);
}

function toolbarCheck(store: Store, key: 'toneMap' | 'hdr', text: string, testid: string, title: string): HTMLElement {
  const label = document.createElement('label');
  label.className = 'btn toolbar-check';
  label.dataset.testid = testid;
  label.title = title;
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = store.state[key];
  cb.setAttribute('aria-label', text);
  cb.addEventListener('change', () => store.patch({ [key]: cb.checked } as Partial<AppState>));
  label.append(cb, document.createTextNode(text));
  store.subscribe(() => {
    if (cb.checked !== store.state[key]) cb.checked = store.state[key];
  });
  return label;
}
