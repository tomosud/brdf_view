// Keeps the address bar in sync with the viewer state, and applies a state
// link typed or pasted into the address bar.
//
// - Writing the URL uses history.replaceState: no history entry, no reload and
//   no hashchange, so it never re-applies the state or redraws.
// - Only the visible BRDFs go into the URL (same as Copy link).
// - While a visible BRDF is not a bundled sample (an opened .brdf file or a
//   measured MERL / RGL BRDF), the URL is left as it is.
// - A hashchange (the user edited the URL) applies that state immediately.

import type { Store } from '../state/store.js';
import { applyState, linkState, stateFromParams, stateToHash, type ViewMap } from '../api/state.js';

const INTERVAL_MS = 400;

export function startUrlSync(store: Store, views: ViewMap): void {
  let applying = false;

  const sync = async () => {
    if (applying || document.hidden) return;
    const state = linkState(store, views);
    const brdfs = state.brdfs ?? [];
    if (!brdfs.length || brdfs.some((b) => !b.file)) return; // external BRDF: leave the URL alone
    const hash = await stateToHash(state);
    if (applying || location.hash.slice(1) === hash) return;
    history.replaceState(history.state, '', `${location.pathname}${location.search}#${hash}`);
  };

  // Polling catches every kind of change (store, view sliders, camera drags,
  // async environment / mesh loads) without hooking each control.
  window.setInterval(() => void sync(), INTERVAL_MS);
  void sync();

  window.addEventListener('hashchange', async () => {
    const state = await stateFromParams(location.hash);
    if (!state) return;
    applying = true;
    try {
      const warnings = await applyState(store, views, state);
      for (const w of warnings) console.warn(`[brdfView] ${w}`);
    } finally {
      applying = false;
    }
  });
}
