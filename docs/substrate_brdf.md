# Unreal Engine 5 Substrate BRDF implementation notes

This note documents the local BRDF approximation implemented in
`sample/brdf/substrate.brdf`.

## References checked

- Epic Games documentation: "Overview of Substrate Materials in Unreal Engine"
  - https://dev.epicgames.com/documentation/en-us/unreal-engine/overview-of-substrate-materials-in-unreal-engine
- Epic Games documentation: "Substrate Materials in Unreal Engine"
  - https://dev.epicgames.com/documentation/en-us/unreal-engine/substrate-materials-in-unreal-engine
- Burley, "Physically-Based Shading at Disney", 2012
  - https://disneyanimation.com/publications/physically-based-shading-at-disney/

Epic's public documentation describes Substrate primarily as a material
composition framework made from BSDF slabs and operators. It lists and explains
Slab inputs such as Diffuse Albedo, F0, F90, Roughness, Anisotropy,
Second Roughness, Second Roughness Weight, Fuzz Amount, Fuzz Color, and
MFP-related participating-media controls. It does not publish a compact,
drop-in GLSL function for the full renderer implementation.

## Scope

The `.brdf` runtime evaluates one pixel-local function:

```glsl
vec3 BRDF(vec3 L, vec3 V, vec3 N, vec3 X, vec3 Y)
```

That makes the following Substrate features reasonable to approximate:

| Substrate concept | Implemented as |
|---|---|
| Single Slab BSDF | One opaque direct-reflection BRDF |
| Diffuse Albedo | Linearized Lambert diffuse |
| F0 | RGB normal-incidence specular reflectance |
| F90 | RGB grazing reflectance hue/saturation, normalized to unit brightness |
| Roughness | Primary anisotropic GGX lobe |
| Anisotropy | Signed tangent/bitangent GGX aspect ratio |
| Second Roughness | Secondary GGX lobe roughness |
| Second Roughness Weight | Mix weight between primary and secondary specular lobes |
| Fuzz Amount / Fuzz Color / Fuzz Roughness | Charlie sheen lobe with Ashikhmin-style visibility |

The implementation intentionally excludes features that need more than a local
BRDF evaluation:

- Slab graph operators and multi-layer topology
- MFP / SSS / participating media
- Transmittance, thin surfaces, rough refraction, and colored shadows
- Path-traced integration and deferred renderer storage details
- Specular profile assets and glints
- Engine-specific lighting, Lumen, Nanite, and material compilation behavior

## Parameter mapping

`substrate.brdf` exposes the following controls:

| Parameter | Meaning |
|---|---|
| `diffuse_albedo` | Substrate Diffuse Albedo input. |
| `f0` | Substrate F0. For common dielectrics use about `0.04 0.04 0.04`. Metals can use colored values. |
| `f90` | Substrate F90 color. Brightness is normalized so hue/saturation matter most. |
| `roughness` | Primary perceptual roughness. Internally converted to alpha by squaring. |
| `anisotropy` | Signed anisotropy. Positive stretches along tangent X, negative along bitangent Y. |
| `second_roughness` | Secondary perceptual roughness. |
| `second_roughness_weight` | Blend between primary and secondary specular lobes. |
| `fuzz_amount` | Strength of fuzz/sheen retroreflection. |
| `fuzz_color` | Fuzz tint. |
| `fuzz_roughness` | Fuzz lobe roughness for the Charlie distribution. |

The app's `color` parameters are stored as sRGB UI values, then the shader
converts them to linear space with `pow(color, 2.2)`. For that reason, the file
default for `f0` is `0.23 0.23 0.23`, which evaluates to roughly linear `0.04`.
Likewise, the default `diffuse_albedo` of `0.46 0.46 0.46` evaluates to roughly
linear `0.18`.

## BRDF model

The returned BRDF is:

```text
diffuse + mixed_anisotropic_ggx_specular + fuzz
```

Specular uses anisotropic GGX with separable Smith visibility:

```text
specular = F(F0, F90, L.H) * D_GGX_aniso(N.H, H.X, H.Y, ax, ay)
         * V_Smith_GGX_aniso(L, V, ax, ay)
```

The second roughness lobe reuses the same Fresnel and anisotropy direction, but
uses its own roughness:

```text
mixed_specular = mix(primary_lobe, second_lobe, second_roughness_weight)
```

Diffuse uses a conservative local energy approximation:

```text
diffuse = diffuse_albedo / pi * (1 - max(F))
```

This matches the documented Substrate intent that stronger interface
reflectance leaves less energy for diffuse scattering, without requiring a full
engine energy-closure implementation.

F90 handling follows the public documentation behavior in an approximate form:

- Normalize `f90` by its largest RGB component, so its brightness is effectively
  fixed and the exposed control acts as hue/saturation.
- Fade grazing color to black when `max(F0) < 0.02`.
- Interpolate from F0 to the normalized F90 with Schlick's fifth-power term.

Fuzz is modeled with a Charlie distribution and compact visibility term. This is
the same practical family of lobe used by Disney/OpenPBR-style sheen models and
is suitable for comparing the angular response in this viewer, but it is not a
bit-identical copy of Unreal's renderer.

## Known differences from Unreal Engine

This file is a study/visualization BRDF, not a drop-in Unreal shader:

- It uses standard microfacet equations rather than Unreal's private renderer
  code paths.
- It does not implement Substrate material graph composition.
- It has no screen-space, path-traced, ray-traced, virtual-shadow-map, or
  renderer-storage behavior.
- It does not model volumetric mean-free-path scattering or rough refraction.
- It does not use Substrate's optional simplification pipeline for expensive
  multi-slab materials.

The goal is to expose the parts of Substrate's documented Slab BSDF that can be
reasonably inspected as a pixel-local BRDF in this repository.
