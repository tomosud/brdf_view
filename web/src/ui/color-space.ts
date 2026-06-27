export type Rgb = [number, number, number];

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function clampRgb(c: Rgb): Rgb {
  return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
}

export function srgbToLinear(x: number): number {
  const c = clamp01(x);
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(x: number): number {
  const c = clamp01(x);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

export function srgbToLinearRgb(c: Rgb): Rgb {
  return [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];
}

export function linearToSrgbRgb(c: Rgb): Rgb {
  return [linearToSrgb(c[0]), linearToSrgb(c[1]), linearToSrgb(c[2])];
}
