// Default textures that belong to a Lit Object mesh (assets/obj/textures.json,
// copied to public/obj/ by scripts/copy-assets.ts). When such a mesh is selected,
// its images are attached to the BRDF on display: the normal map, and each
// parameter the BRDF has under one of the listed names (base colour, roughness).
//
// Rules:
//   - attached once per BRDF instance per mesh selection, and only to slots that
//     are empty, so images the user dropped are never replaced
//   - if the user removes or replaces one in the parameter panel, it stays that
//     way; selecting the mesh again offers the defaults again
//   - they are removed when another mesh is selected or the option is switched off
//   - they are marked (TextureImage.modelDefault) and not saved with the session:
//     they come back with the mesh
//
// Nothing here is specific to one mesh: add an entry to textures.json.

import { loadTextureImage } from '../brdf/param-texture.js';
import type { BrdfInstance, TextureChannel, TextureColorSpace, TextureImage } from '../brdf/types.js';
import type { Store } from '../state/store.js';

interface ModelTextureSet {
  normalMap?: { file: string; flipY?: boolean; strength?: number };
  params?: { names: string[]; file: string; channel?: TextureChannel; colorSpace?: TextureColorSpace }[];
}

/** "base_color", "baseColor" and "BaseColor" are the same parameter name here. */
const normalizeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

export class ModelTextures {
  private readonly manifest: Promise<Record<string, ModelTextureSet>>;
  private readonly blobs = new Map<string, Promise<Blob>>();
  private mesh = '';
  private enabled = true;
  /** Instances that were offered the current mesh's textures (reset by setMesh / setEnabled). */
  private offered = new WeakSet<BrdfInstance>();
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();

  constructor(private store: Store) {
    this.manifest = fetch(`${import.meta.env.BASE_URL}obj/textures.json`)
      .then((r) => (r.ok ? (r.json() as Promise<Record<string, ModelTextureSet>>) : {}))
      .catch(() => ({}));
    // a BRDF that becomes visible later is offered the textures too
    store.subscribe(() => this.schedule());
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Call when the Lit Object mesh changes (also when the same mesh is selected again). */
  setMesh(name: string): void {
    this.mesh = name;
    this.restart();
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.restart();
  }

  /** Resolves when no attachment is in flight (awaited before snapshots). */
  settled(): Promise<void> {
    return this.pending;
  }

  private restart(): void {
    this.generation++;
    this.offered = new WeakSet();
    this.schedule();
  }

  private schedule(): void {
    const generation = this.generation;
    this.pending = this.pending.then(() => this.sync(generation)).catch((e) => console.warn('[brdfView] model textures', e));
  }

  private async sync(generation: number): Promise<void> {
    if (generation !== this.generation) return;
    const set = this.enabled ? (await this.manifest)[this.mesh] : undefined;
    if (generation !== this.generation) return;
    this.removeOthers(set ? this.mesh : null);
    const inst = this.store.topmostEnabled()?.instance;
    if (!set || !inst || inst.def.measured || this.offered.has(inst)) return;
    this.offered.add(inst);
    const stale = () => generation !== this.generation || !this.store.state.brdfs.includes(inst);

    if (set.normalMap && !inst.normalMap) {
      const img = await this.image(set.normalMap.file);
      if (stale() || inst.normalMap) URL.revokeObjectURL(img.url);
      else this.store.setNormalMap(inst.id, { ...img, flipY: set.normalMap.flipY ?? true, strength: set.normalMap.strength ?? 1 });
    }
    for (const entry of set.params ?? []) {
      const names = entry.names.map(normalizeName);
      const p = inst.def.params.find((x) => x.kind !== 'bool' && names.includes(normalizeName(x.name)));
      if (!p || inst.textures?.has(p.name)) continue;
      const img = await this.image(entry.file);
      if (stale() || inst.textures?.has(p.name)) {
        URL.revokeObjectURL(img.url);
        continue;
      }
      const channel: TextureChannel = p.kind === 'color' ? 'rgb' : entry.channel && entry.channel !== 'rgb' ? entry.channel : 'r';
      this.store.setParamTexture(inst.id, p.name, { ...img, channel, colorSpace: entry.colorSpace ?? 'linear' });
    }
  }

  /** Detach the default textures of every mesh but `keep` (null: of every mesh). */
  private removeOthers(keep: string | null): void {
    for (const inst of this.store.state.brdfs) {
      for (const [name, t] of [...(inst.textures ?? [])]) {
        if (t.modelDefault && t.modelDefault !== keep) this.store.setParamTexture(inst.id, name, null);
      }
      if (inst.normalMap?.modelDefault && inst.normalMap.modelDefault !== keep) this.store.setNormalMap(inst.id, null);
    }
  }

  /** One decoded image per attachment (each owns its object URL); the file is fetched once. */
  private async image(file: string): Promise<TextureImage> {
    let blob = this.blobs.get(file);
    if (!blob) {
      blob = fetch(`${import.meta.env.BASE_URL}obj/textures/${file}`).then((r) => {
        if (!r.ok) throw new Error(`${file}: ${r.status}`);
        return r.blob();
      });
      this.blobs.set(file, blob);
    }
    const img = await loadTextureImage(await blob, file);
    return { ...img, modelDefault: this.mesh };
  }
}
