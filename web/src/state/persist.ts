// IndexedDB-backed session persistence. Saves loaded BRDFs (bundled samples
// and user-uploaded text .brdf files) and restores them on reload.
// MERL .binary files are skipped (too large to cache).
//
// Images attached to BRDFs (parameter textures, normal maps) are saved too:
// the image files go to a separate "blobs" store, written once per image, and
// the session refers to them by id. Images no longer referenced are deleted.

import type { Store } from './store.js';
import { loadBundledBrdf, instanceFromDef } from '../brdf/loader.js';
import { parseBrdf } from '../brdf/parser.js';
import { loadTextureImage } from '../brdf/param-texture.js';
import type { BrdfInstance, ParamValue, TextureChannel, TextureColorSpace } from '../brdf/types.js';
import { linearToSrgbRgb } from '../ui/color-space.js';

const DB_NAME = 'brdf-explorer';
const DB_VERSION = 2;
const STORE_NAME = 'session';
const BLOB_STORE = 'blobs';
const SESSION_KEY = 'current';

interface SavedImage {
  id: string;
  fileName: string;
}

interface SavedBrdf {
  kind: 'bundled' | 'text';
  filename: string;
  name: string;
  content?: string;
  values: Record<string, ParamValue>;
  visible: boolean;
  textures?: Record<string, SavedImage & { channel: TextureChannel; colorSpace: TextureColorSpace }>;
  normalMap?: SavedImage & { flipY: boolean; strength: number };
}

interface SavedSession {
  colorSpace?: 'linear' | 'srgb';
  brdfs: SavedBrdf[];
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let _db: IDBDatabase | null = null;
async function getDb(): Promise<IDBDatabase> {
  _db ??= await openDb();
  return _db;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(d: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return request(d.transaction(store, 'readonly').objectStore(store).get(key)) as Promise<T | undefined>;
}

function idbPut(d: IDBDatabase, store: string, key: string, value: unknown): Promise<unknown> {
  return request(d.transaction(store, 'readwrite').objectStore(store).put(value, key));
}

/** Image ids known to be in the blob store (filled lazily from the store's keys). */
let _savedBlobIds: Set<string> | null = null;

async function saveImages(d: IDBDatabase, images: Map<string, Blob>): Promise<void> {
  _savedBlobIds ??= new Set((await request(d.transaction(BLOB_STORE, 'readonly').objectStore(BLOB_STORE).getAllKeys())).map(String));
  for (const [id, blob] of images) {
    if (_savedBlobIds.has(id)) continue;
    await idbPut(d, BLOB_STORE, id, blob);
    _savedBlobIds.add(id);
  }
  // Drop images no longer used by the session.
  const stale = [...(_savedBlobIds ?? [])].filter((id) => !images.has(id));
  if (stale.length) {
    const tx = d.transaction(BLOB_STORE, 'readwrite');
    for (const id of stale) {
      tx.objectStore(BLOB_STORE).delete(id);
      _savedBlobIds.delete(id);
    }
  }
}

async function saveSession(store: Store): Promise<void> {
  const brdfs: SavedBrdf[] = [];
  const images = new Map<string, Blob>();
  for (const inst of store.state.brdfs) {
    const origin = inst.def.origin;
    if (!origin) continue; // skip MERL measured BRDFs
    const values: Record<string, ParamValue> = {};
    for (const [k, v] of inst.values) {
      values[k] = Array.isArray(v) ? ([...v] as [number, number, number]) : v;
    }
    const saved: SavedBrdf =
      origin.kind === 'bundled'
        ? { kind: 'bundled', filename: origin.filename, name: inst.def.name, values, visible: inst.visible }
        : { kind: 'text', filename: '', name: inst.def.name, content: origin.content, values, visible: inst.visible };
    // A mesh's default textures (views/model-textures.ts) are not saved: they come back with the mesh.
    for (const [name, t] of inst.textures ?? []) {
      if (t.modelDefault) continue;
      (saved.textures ??= {})[name] = { id: t.id, fileName: t.fileName, channel: t.channel, colorSpace: t.colorSpace };
      images.set(t.id, t.blob);
    }
    if (inst.normalMap && !inst.normalMap.modelDefault) {
      const n = inst.normalMap;
      saved.normalMap = { id: n.id, fileName: n.fileName, flipY: n.flipY, strength: n.strength };
      images.set(n.id, n.blob);
    }
    brdfs.push(saved);
  }
  try {
    const d = await getDb();
    await saveImages(d, images);
    await idbPut(d, STORE_NAME, SESSION_KEY, { colorSpace: 'srgb', brdfs } satisfies SavedSession);
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

async function readSession(): Promise<{ d: IDBDatabase; session: SavedSession } | null> {
  try {
    const d = await getDb();
    const session = await idbGet<SavedSession>(d, STORE_NAME, SESSION_KEY);
    return session?.brdfs?.length ? { d, session } : null;
  } catch (e) {
    console.warn('IndexedDB restore failed', e);
    return null;
  }
}

/** Re-attach a saved BRDF's images (missing image files are skipped). */
async function attachImages(d: IDBDatabase, inst: BrdfInstance, saved: SavedBrdf): Promise<boolean> {
  let attached = false;
  const load = async (img: SavedImage) => {
    const blob = await idbGet<Blob>(d, BLOB_STORE, img.id);
    if (!blob) {
      console.warn(`Saved image "${img.fileName}" is missing; skipped`);
      return null;
    }
    return loadTextureImage(blob, img.fileName, img.id);
  };
  for (const [name, t] of Object.entries(saved.textures ?? {})) {
    const p = inst.def.params.find((x) => x.name === name);
    if (!p || p.kind === 'bool') continue;
    try {
      const img = await load(t);
      if (!img) continue;
      (inst.textures ??= new Map()).set(name, { ...img, channel: t.channel, colorSpace: t.colorSpace });
      attached = true;
    } catch (e) {
      console.warn(`Could not restore image "${t.fileName}" for ${name}`, e);
    }
  }
  if (saved.normalMap) {
    try {
      const img = await load(saved.normalMap);
      if (img) {
        inst.normalMap = { ...img, flipY: saved.normalMap.flipY, strength: saved.normalMap.strength };
        attached = true;
      }
    } catch (e) {
      console.warn(`Could not restore normal map "${saved.normalMap.fileName}"`, e);
    }
  }
  return attached;
}

/**
 * Restore the previous session from IndexedDB.
 * Returns true if at least one BRDF was loaded (so the caller can skip seeding defaults).
 * Missing bundled files are silently skipped.
 */
export async function restoreSession(store: Store): Promise<boolean> {
  const read = await readSession();
  if (!read) return false;
  const { d, session } = read;

  let restored = false;
  for (const saved of session.brdfs) {
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
      await attachImages(d, inst, saved);
      store.addBrdf(inst, false); // preserve saved visibility; don't auto-solo
      restored = true;
    } catch (e) {
      console.warn(`Skipping BRDF "${saved.name}" (could not restore):`, e);
    }
  }
  return restored;
}

/**
 * After a state link was applied: re-attach the images saved for the same
 * BRDFs (same bundled file / same .brdf text) in the previous session.
 */
export async function restoreImages(store: Store): Promise<void> {
  const read = await readSession();
  if (!read) return;
  const { d, session } = read;
  const used = new Set<SavedBrdf>();
  let changed = false;
  for (const inst of store.state.brdfs) {
    // images the user attached win; a mesh's default textures do not count
    const own = [...(inst.textures?.values() ?? [])].some((t) => !t.modelDefault) || (!!inst.normalMap && !inst.normalMap.modelDefault);
    if (own) continue;
    const o = inst.def.origin;
    const saved = session.brdfs.find(
      (s) =>
        !used.has(s) &&
        (s.textures || s.normalMap) &&
        ((o?.kind === 'bundled' && s.kind === 'bundled' && s.filename === o.filename) ||
          (o?.kind === 'text' && s.kind === 'text' && s.content === o.content)),
    );
    if (!saved) continue;
    used.add(saved);
    changed = (await attachImages(d, inst, saved)) || changed;
  }
  if (changed) store.emit();
}
