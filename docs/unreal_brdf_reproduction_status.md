# Unreal BRDF reproduction status

Last verified: 2026-07-04

Target files:

- `sample/brdf/unreal_legacy_pbr.brdf`
- `sample/brdf/substrate.brdf`

Reference source:

- Local Unreal shaders: `C:\work\unreal\Shaders`
- Substrate shaders: `C:\work\unreal\Shaders\Private\Substrate`
- Article checked for comparison: https://mstone8370.tistory.com/57

This project implements a single local BRDF function:

```glsl
vec3 BRDF(vec3 L, vec3 V, vec3 N, vec3 X, vec3 Y)
```

Renderer-side behavior such as light attenuation, area-light integration, shadows,
GBuffer packing, material graph topology, IBL preintegration, and path tracing is
outside the scope of these `.brdf` files.

## Summary

`sample/brdf/substrate.brdf` should keep rough diffuse fixed on.

The important nuance is that the article and the local source do not match on
the concrete rough-diffuse model:

- The article shows `ROUGH_DIFFUSE_BRDF_VERSION 2`, which selects the Chan 2024
  branch inside `Diffuse_GGX_Rough`.
- The local source currently has `ROUGH_DIFFUSE_BRDF_VERSION 3` in
  `C:\work\unreal\Shaders\Private\BRDF.ush:235`.
- Version 3 calls `Diffuse_EON(DiffuseColor, RetroReflectivityWeight * Roughness * 0.4, ...)`
  at `BRDF.ush:249`.

So for the local source, Substrate diffuse is best described as:

```text
Substrate diffuse = Diffuse_GGX_Rough
                  = Diffuse_EON with roughness * 0.4
```

when rough diffuse is enabled and diffuse color is non-zero.

## Substrate rough diffuse

The direct-lighting Substrate path in the local source matches the article's
outer control flow:

- `C:\work\unreal\Shaders\Private\Substrate\SubstrateEvaluation.ush:552`
  checks `MATERIAL_ROUGHDIFFUSE`.
- `SubstrateEvaluation.ush:553` checks `Settings.bRoughDiffuseEnabled && any(DiffuseColor > 0)`.
- `SubstrateEvaluation.ush:560` uses `Diffuse_GGX_Rough(...)`.
- `SubstrateEvaluation.ush:565` falls back to `Diffuse_Lambert(DiffuseColor)`.

`FSubstrateIntegrationSettings` stores the runtime flag as
`bRoughDiffuseEnabled` in `Substrate.ush:2351`. Its default constructor path
returns rough diffuse enabled at `Substrate.ush:2376`. Many actual passes pass
`Substrate.bRoughDiffuse` / `SubstrateStruct.bRoughDiffuse`, and some specialized
passes pass `true` or `false` explicitly.

For this viewer's `substrate.brdf`, the right approximation is to represent the
normal Substrate slab direct-lighting path, so `rough_diffuse` is fixed to
`true` and hidden from the UI:

- `sample/brdf/substrate.brdf`: `const bool rough_diffuse = true`
- Diffuse implementation: local `diffuseEON(...)`
- Roughness input: `makeRoughnessSafe(roughness, 0.02) * 0.4`

This matches the local source's `ROUGH_DIFFUSE_BRDF_VERSION == 3` path.

## Legacy Default Lit diffuse

`sample/brdf/unreal_legacy_pbr.brdf` represents the normal legacy Default Lit
path. The local shader has a compile-time rough-diffuse path in
`ShadingModels.ush`, but the usual legacy Default Lit diffuse model is Lambert
unless the rough-diffuse material permutation is enabled.

For this viewer, legacy rough diffuse is intentionally fixed off:

- `sample/brdf/unreal_legacy_pbr.brdf`: `const bool rough_diffuse = false`
- Diffuse implementation: `diffuseLambert(diffuseColor)`

The file still contains the EON helper for reference and for the inactive
compile-time branch, but the UI no longer exposes a rough-diffuse toggle.

## Diffuse model comparison

| Case | Article | Local Unreal source | Viewer `.brdf` |
|---|---|---|---|
| Substrate rough diffuse enable | Article says Substrate forces rough diffuse on | Source uses `Settings.bRoughDiffuseEnabled`; normal Substrate paths pass the Substrate rough-diffuse flag/default | Fixed on |
| `Diffuse_GGX_Rough` version | Version 2 in article | Version 3 in `BRDF.ush:235` | Version 3 behavior |
| Concrete diffuse model | Chan 2024 branch | EON branch via `Diffuse_EON(... roughness * 0.4 ...)` | EON branch via `diffuseEON(... roughness * 0.4 ...)` |
| Fallback | Lambert | Lambert if rough diffuse disabled or diffuse is zero | Present but inactive for normal Substrate path |
| Legacy Default Lit | Not the article focus | Lambert unless rough-diffuse permutation is enabled | Fixed Lambert |

## Other reproduction decisions

These are already reflected in the current `.brdf` files:

- Minimum roughness is `0.02`, matching UE's `View.MinRoughness` / Substrate
  sanitization expectation.
- Anisotropic alpha minimum remains `0.001`, separate from perceptual roughness
  minimum.
- `dGGXAniso` uses a tiny denominator guard (`1e-20`) instead of the general
  visibility epsilon, so low-roughness anisotropic highlights are not flattened.
- Substrate F90 is used as generalized Schlick grazing color and multiplied by
  `F0RGBToMicroOcclusion(F0)`; it is not normalized by max RGB.
- Legacy GGX multiple-scattering energy compensation is always on in the viewer,
  matching modern UE/Substrate-enabled expectations rather than old
  Substrate-disabled cvar defaults.

## Known omissions

The `.brdf` files do not attempt to reproduce:

- Light shape / LTC area-light integration.
- Shadows, distance attenuation, or renderer light color handling.
- GBuffer packing, deferred storage, and material graph topology.
- Substrate MFP, SSS, thin surface, transmission, rough refraction, glints,
  specular profile LUTs, and path tracing.
- Substrate fuzz's small additional cloth energy-conservation multiplier. The
  main Charlie/Ashikhmin fuzz lobe and lower-layer attenuation are represented.

