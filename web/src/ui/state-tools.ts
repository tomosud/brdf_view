// Sidebar tools for sharing and scripting the viewer state: "Copy link" and a
// "State JSON" panel (refresh / apply / download). Both use window.brdfView.

import type { ViewerState } from '../api/state.js';

interface Api {
  getState(): ViewerState;
  setState(state: ViewerState | string): Promise<{ warnings: string[] }>;
  getLink(): Promise<string>;
}

function api(): Api {
  return (window as unknown as { brdfView: Api }).brdfView;
}

export function mountStateTools(toolbar: HTMLElement): void {
  const copyLink = button('Copy link', 'copy-link', 'Copy a link that reopens this exact state (BRDF, parameters, light, view settings)');
  const toggle = button('State JSON', 'state-json-toggle', 'Show the whole viewer state as JSON (paste to apply, or export)');
  toggle.setAttribute('aria-expanded', 'false');
  const anchor = toolbar.querySelector('#load-sample-brdf');
  if (anchor) anchor.after(copyLink, toggle);
  else toolbar.append(copyLink, toggle);

  const panel = document.createElement('div');
  panel.className = 'state-panel';
  panel.dataset.testid = 'state-panel';
  panel.hidden = true;

  const textarea = document.createElement('textarea');
  textarea.className = 'state-json';
  textarea.dataset.testid = 'state-json';
  textarea.setAttribute('aria-label', 'Viewer state JSON');
  textarea.spellcheck = false;
  textarea.rows = 12;

  const actions = document.createElement('div');
  actions.className = 'state-actions';
  const refresh = button('Refresh', 'state-refresh', 'Write the current state into the box');
  const apply = button('Apply', 'state-apply', 'Apply the JSON (or a pasted link) in the box');
  const download = button('Download', 'state-download', 'Save the current state as brdf_view_state.json');
  for (const b of [refresh, apply, download]) b.classList.add('btn-compact');
  actions.append(refresh, apply, download);

  const status = document.createElement('div');
  status.className = 'state-status';
  status.dataset.testid = 'state-status';
  status.setAttribute('role', 'status');

  panel.append(textarea, actions, status);
  toolbar.after(panel);

  const say = (text: string, error = false) => {
    status.textContent = text;
    status.classList.toggle('state-status-error', error);
  };
  const fill = () => {
    textarea.value = JSON.stringify(api().getState(), null, 2);
  };

  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) {
      fill();
      say('');
    }
  });
  refresh.addEventListener('click', () => {
    fill();
    say('Current state.');
  });
  apply.addEventListener('click', async () => {
    try {
      const { warnings } = await api().setState(textarea.value);
      say(warnings.length ? `Applied with warnings:\n${warnings.join('\n')}` : 'Applied.', warnings.length > 0);
    } catch (e) {
      say(`Could not apply: ${(e as Error).message}`, true);
    }
  });
  download.addEventListener('click', () => {
    const text = `${JSON.stringify(api().getState(), null, 2)}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'brdf_view_state.json';
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
  copyLink.addEventListener('click', async () => {
    const link = await api().getLink();
    try {
      await navigator.clipboard.writeText(link);
      flash(copyLink, 'Copied');
    } catch {
      // Clipboard blocked: show the link so it can be copied by hand.
      panel.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      textarea.value = link;
      textarea.select();
      say('Clipboard unavailable; the link is selected in the box.');
    }
    copyLink.dataset.link = link;
  });
}

function button(text: string, testid: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn';
  b.textContent = text;
  b.title = title;
  b.dataset.testid = testid;
  return b;
}

function flash(b: HTMLButtonElement, text: string): void {
  const prev = b.textContent;
  b.textContent = text;
  window.setTimeout(() => {
    b.textContent = prev;
  }, 900);
}
