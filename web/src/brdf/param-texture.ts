// Image files used as parameter textures and normal maps (Lit Object only).

import type { BrdfInstance, ParamDef, TextureChannel, TextureColorSpace, TextureImage } from './types.js';
import type { TextureBinding } from './shader-builder.js';

export async function loadTextureImage(blob: Blob, fileName: string, id: string = newImageId()): Promise<TextureImage> {
  if (blob.type && !blob.type.startsWith('image/')) throw new Error(`${fileName} is not an image`);
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error(`${fileName}: the browser could not decode this image (use PNG / JPEG / WebP)`);
  }
  return { id, blob, fileName, image, url, width: image.naturalWidth, height: image.naturalHeight };
}

function newImageId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Default encoding of an image dropped on a parameter: base color is sRGB, everything else linear. */
export function defaultColorSpace(name: string): TextureColorSpace {
  return /base_?colou?r|albedo/i.test(name) ? 'srgb' : 'linear';
}

/** Default channel: RGB for color parameters, R for float parameters. */
export function defaultChannel(p: ParamDef): TextureChannel {
  return p.kind === 'color' ? 'rgb' : 'r';
}

/**
 * Shader bindings for the instance's textured parameters. Values are converted
 * to the domain the .brdf expects: color parameters are sRGB values (the .brdf
 * applies mon2lin, like for the color picker), float parameters are linear.
 */
export function textureBindings(inst: BrdfInstance): TextureBinding[] {
  if (!inst.textures?.size) return [];
  const out: TextureBinding[] = [];
  for (const p of inst.def.params) {
    const t = inst.textures.get(p.name);
    if (!t || p.kind === 'bool') continue;
    const convert =
      p.kind === 'color' ? (t.colorSpace === 'linear' ? 'toSrgb' : 'none') : t.colorSpace === 'srgb' ? 'toLinear' : 'none';
    out.push({ name: p.name, channel: p.kind === 'color' ? 'rgb' : t.channel === 'rgb' ? 'r' : t.channel, convert });
  }
  return out;
}
