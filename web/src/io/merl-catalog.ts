import { loadMeasuredFromUrl } from './file-open.js';
import type { BrdfInstance } from '../brdf/types.js';

export interface MerlMaterial {
  name: string;
  fileName: string;
  size: number;
  downloadUrl: string;
}

export interface MerlCatalog {
  releaseTag: string;
  source: string;
  count: number;
  generatedAt: string;
  materials: MerlMaterial[];
}

export async function loadMerlCatalog(): Promise<MerlCatalog> {
  const res = await fetch(`${import.meta.env.BASE_URL}merl/materials.json`);
  if (!res.ok) throw new Error(`failed to load MERL catalog: ${res.status}`);
  return res.json() as Promise<MerlCatalog>;
}

export async function loadMerlMaterial(material: MerlMaterial): Promise<BrdfInstance> {
  return loadMeasuredFromUrl(material.downloadUrl, material.name, {
    kind: 'merl-online',
    name: material.name,
    fileName: material.fileName,
    downloadUrl: material.downloadUrl,
    size: material.size,
  });
}
