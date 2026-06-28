# Unreal Engine 5 Substrate BRDF implementation notes

This note documents `sample/brdf/substrate.brdf`.

## Sources checked

- Epic documentation:
  - https://dev.epicgames.com/documentation/en-us/unreal-engine/overview-of-substrate-materials-in-unreal-engine
  - https://dev.epicgames.com/documentation/en-us/unreal-engine/substrate-materials-in-unreal-engine
- Local Unreal shader sources:
  - `C:\work\unreal\Shaders\Private\Substrate\Substrate.ush`
  - `C:\work\unreal\Shaders\Private\Substrate\SubstrateEvaluation.ush`
  - `C:\work\unreal\Shaders\Private\BRDF.ush`
  - `C:\work\unreal\Shaders\Private\ShadingCommon.ush`
  - `C:\work\unreal\Shaders\Private\ShadingEnergyConservation.ush`
  - `C:\work\unreal\Shaders\Private\ShadingEnergyConservationTemplate.ush`

## Scope

The `.brdf` format exposes a local function:

```glsl
vec3 BRDF(vec3 L, vec3 V, vec3 N, vec3 X, vec3 Y)
```

So this implementation targets a single opaque Substrate Slab direct-lighting
BRDF. It does not attempt to reproduce engine storage, graph topology, path
tracing, area-light integration, or LUT-backed renderer features.

## Implemented mapping

| Substrate / UE concept | Local implementation |
|---|---|
| Diffuse Albedo | sRGB UI color converted to linear, evaluated with UE's EON-style rough diffuse approximation. |
| F0 | sRGB UI color converted to linear. Default `0.23` becomes roughly linear `0.04`. |
| F90 | Normalized by max RGB, then multiplied by UE-style F0 micro-occlusion. |
| Roughness | Primary GGX lobe, clamped to UE-style safe roughness. |
| Anisotropy | UE/Disney-style anisotropic GGX alpha mapping. |
| Second Roughness / Weight | UE Haziness approximation: secondary GGX lobe mixed by weight. |
| `second_roughness_as_clearcoat` | Simplified clearcoat-like Haziness path with top lobe F0=0.04/F90=1. |
| Fuzz | Deprecated UE fallback approximation: Charlie NDF + Ashikhmin visibility, with lower-lobe attenuation. |
| Specular energy | UE analytic GGX energy approximation, replacing unavailable LUT lookups. |

## Important differences from full UE

- UE's current fuzz path uses Sheen LTC textures. This `.brdf` uses the older
  Charlie/Ashikhmin fallback because the viewer has no LTC texture.
- UE's default energy conservation path can use precomputed LUTs. This file uses
  the analytic approximation present in `ShadingEnergyConservation.ush`.
- Area-light LTCs, glints, specular-profile LUTs, thin-film F0/F90 baking,
  SSS/MFP, transmission, rough refraction, and graph layering are not included.
- Clearcoat-style Haziness is simplified and does not include the full UE
  bottom-normal or `SimpleClearCoatTransmittance` behavior.

## Color parameter note

The app stores `color` parameters as sRGB UI values, then shader code converts
them with `pow(color, 2.2)`. Therefore:

- `f0 = 0.23 0.23 0.23` evaluates to about linear `0.04`.
- `diffuse_albedo = 0.46 0.46 0.46` evaluates to about linear `0.18`.

## Validation status

This is still a validation implementation. It should be compared against Unreal
with simple Slab materials before treating numeric output as authoritative.
