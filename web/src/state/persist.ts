// IndexedDB-backed session persistence. Saves loaded BRDFs (bundled samples,
// user-uploaded text .brdf files, and online MERL URLs) and restores them on
// reload. MERL .binary payloads are never cached.

import type { Store } from './store.js';
import { loadBundledBrdf, instanceFromDef } from '../brdf/loader.js';
import { parseBrdf } from '../brdf/parser.js';
import type { ParamValue } from '../brdf/types.js';
import { linearToSrgbRgb } from '../ui/color-space.js';
import { loadMerlMaterial, type MerlMaterial } from '../io/merl-catalog.js';

const DB_NAME = 'brdf-explorer';
const DB_VERSION = 1;
const STORE_NAME = 'session';
const SESSION_KEY = 'current';

interface SavedBrdf {
  kind: 'bundled' | 'text' | 'merl-online';
  filename: string;
  name: string;
  content?: string;
  fileName?: string;
  downloadUrl?: string;
  size?: number;
  values: Record<string, ParamValue>;
  visible: boolean;
}

interface SavedSession {
  colorSpace?: 'linear' | 'srgb';
  brdfs: SavedBrdf[];
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let _db: IDBDatabase | null = null;
async function getDb(): Promise<IDBDatabase> {
  _db ??= await openDb();
  return _db;
}

function idbGet<T>(d: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = d.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(d: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = d.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function saveSession(store: Store): Promise<void> {
  const brdfs: SavedBrdf[] = [];
  for (const inst of store.state.brdfs) {
    const origin = inst.def.origin;
    if (!origin) continue; // skip local MERL measured BRDFs
    const values: Record<string, ParamValue> = {};
    for (const [k, v] of inst.values) {
      values[k] = Array.isArray(v) ? ([...v] as [number, number, number]) : v;
    }
    if (origin.kind === 'bundled') {
      brdfs.push({ kind: 'bundled', filename: origin.filename, name: inst.def.name, values, visible: inst.visible });
    } else if (origin.kind === 'text') {
      brdfs.push({ kind: 'text', filename: '', name: inst.def.name, content: origin.content, values, visible: inst.visible });
    } else {
      brdfs.push({
        kind: 'merl-online',
        filename: origin.fileName,
        name: origin.name,
        fileName: origin.fileName,
        downloadUrl: origin.downloadUrl,
        size: origin.size,
        values,
        visible: inst.visible,
      });
    }
  }
  try {
    const d = await getDb();
    await idbPut(d, SESSION_KEY, { colorSpace: 'srgb', brdfs } satisfies SavedSession);
  } catch (e) {
    console.warn('IndexedDB save failed', e);
  }
}

let _saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Schedule a debounced save (500 ms). Call this from store.subscribe(). */
export function scheduleSave(store: Store): void {
  if (_saveTimer !== null) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    void saveSession(store);
  }, 500);
}

/**
 * Restore the previous session from IndexedDB.
 * Returns true if at least one BRDF was loaded (so the caller can skip seeding defaults).
 * Missing bundled files are silently skipped.
 */
export async function restoreSession(store: Store): Promise<boolean> {
  let session: SavedSession | undefined;
  try {
    const d = await getDb();
    session = await idbGet<SavedSession>(d, SESSION_KEY);
  } catch (e) {
    console.warn('IndexedDB restore failed', e);
    return false;
  }
  if (!session?.brdfs?.length) return false;

  let restored = false;
  for (const saved of session.brdfs) {
    if (saved.kind === 'merl-online') {
      if (saved.downloadUrl) {
        setTimeout(() => {
          void restoreOnlineMerl(store, saved);
        }, 0);
        restored = true;
      }
      continue;
    }

    try {
      let inst;
      if (saved.kind === 'bundled') {
        inst = await loadBundledBrdf(saved.filename);
      } else if (saved.content) {
        const def = parseBrdf(saved.name, saved.content);
        def.origin = { kind: 'text', name: saved.name, content: saved.content };
        inst = instanceFromDef(def);
      } else {
        continue;
      }
      // Apply saved parameter values
      for (const [k, v] of Object.entries(saved.values)) {
        const param = inst.def.params.find((p) => p.name === k);
        if (!param || !inst.values.has(k)) continue;
        if (session.colorSpace === 'linear' && param.kind === 'color' && Array.isArray(v)) {
          inst.values.set(k, linearToSrgbRgb(v as [number, number, number]));
        } else {
          inst.values.set(k, v);
        }
      }
      inst.visible = saved.visible;
      store.addBrdf(inst, false); // preserve saved visibility; don't auto-solo
      restored = true;
    } catch (e) {
      console.warn(`Skipping BRDF "${saved.name}" (could not restore):`, e);
    }
  }
  return restored;
}

async function restoreOnlineMerl(store: Store, saved: SavedBrdf): Promise<void> {
  if (!saved.downloadUrl) return;
  try {
    const material: MerlMaterial = {
      name: saved.name,
      fileName: saved.fileName ?? saved.filename,
      downloadUrl: saved.downloadUrl,
      size: saved.size ?? 0,
    };
    const inst = await loadMerlMaterial(material);
    inst.visible = saved.visible;
    store.addBrdf(inst, false); // preserve saved visibility; don't auto-solo
  } catch (e) {
    console.warn(`Skipping MERL BRDF "${saved.name}" (could not restore):`, e);
  }
}
