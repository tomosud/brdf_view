# Unreal Engine 5 Substrate BRDF notes

This note documents [`sample/brdf/substrate.brdf`](../sample/brdf/substrate.brdf).

The file is a validation implementation, not a complete Unreal renderer port.
It should be read as:

> UE5 Substrate opaque Slab direct-lighting, approximated inside the local
> `.brdf` contract `BRDF(L,V,N,X,Y)`.

## Sources checked

Local Unreal shader sources:

- `C:\work\unreal\Shaders\Private\Substrate\Substrate.ush`
- `C:\work\unreal\Shaders\Private\Substrate\SubstrateEvaluation.ush`
- `C:\work\unreal\Shaders\Private\BRDF.ush`
- `C:\work\unreal\Shaders\Private\ShadingCommon.ush`
- `C:\work\unreal\Shaders\Private\ShadingEnergyConservation.ush`
- `C:\work\unreal\Shaders\Private\ShadingEnergyConservationTemplate.ush`

Public Unreal documentation:

- https://dev.epicgames.com/documentation/en-us/unreal-engine/overview-of-substrate-materials-in-unreal-engine
- https://dev.epicgames.com/documentation/en-us/unreal-engine/substrate-materials-in-unreal-engine

## Scope

The viewer calls a single local function:

```glsl
vec3 BRDF(vec3 L, vec3 V, vec3 N, vec3 X, vec3 Y)
```

The implementation therefore includes only local direct-lighting terms. It cannot
represent full Substrate graph evaluation, renderer storage, material topology,
or non-local integration.

## Parameters

| Parameter | Meaning |
|---|---|
| `diffuse_albedo` | Slab diffuse albedo, stored as sRGB UI color and converted to linear. |
| `f0` | Specular F0 color, stored as sRGB UI color and converted to linear. Default `0.23` is about linear `0.04`. |
| `f90` | Edge tint before UE-style max-RGB normalization and F0 micro-occlusion. |
| `roughness` | Primary perceptual roughness. |
| `anisotropy` | Anisotropic GGX directionality. Positive and negative values swap the stretched tangent axis. |
| `second_roughness` | Secondary roughness used as Haziness-like secondary lobe. |
| `second_roughness_weight` | Blend/weight for the secondary lobe. |
| `second_roughness_as_clearcoat` | Uses a simplified clearcoat-like secondary lobe with F0=0.04 and F90=1. |
| `fuzz_amount` | Adds a cloth/sheen-like fuzz lobe and attenuates lower lobes. |
| `fuzz_color` | Fuzz F0 color, stored as sRGB UI color and converted to linear. |
| `fuzz_roughness` | Fuzz roughness. |

## Implemented mapping

| UE / Substrate concept | Local implementation |
|---|---|
| Slab specular | GGX or anisotropic GGX. |
| NDF | UE-style `D_GGX` / `D_GGXaniso`. |
| Visibility | UE-style `Vis_SmithJoint` / `Vis_SmithJointAniso`. |
| Fresnel | Generalized Schlick using F0 and F90. |
| F90 handling | Normalize F90 by max RGB, then multiply by `F0RGBToMicroOcclusion(F0)`. |
| Specular energy | Analytic GGX energy approximation from UE's energy-conservation shader path. |
| Diffuse | UE-style EON rough diffuse approximation, called with `roughness * 0.4`. |
| Haziness / SecondRoughness | Secondary GGX lobe approximation. |
| Clearcoat-like second lobe | Simplified top lobe path controlled by `second_roughness_as_clearcoat`. |
| Fuzz | Deprecated Charlie/Ashikhmin-style fallback plus lower-lobe attenuation. |

## Important differences from full UE

- UE's current fuzz path can use Sheen LTC textures. This `.brdf` uses the older
  Charlie/Ashikhmin fallback because the viewer has no LTC texture.
- UE can use precomputed energy LUT textures. This file uses the analytic
  approximation path only.
- Area-light LTCs, rect/capsule light handling, glints, and specular profile LUTs
  are not included.
- SSS/MFP, transmission, thin surfaces, and rough refraction are not included.
- Substrate graph topology, simplification, packed closure storage, and deferred
  renderer integration are not included.
- Clearcoat-like Haziness is simplified and does not fully reproduce bottom normal
  handling or UE `SimpleClearCoatTransmittance`.
- Path tracing paths are out of scope.

## Color parameter note

The app stores `color` parameters as sRGB UI values. The BRDF converts them with
`pow(color, 2.2)` inside the shader.

Examples:

- `f0 = 0.23 0.23 0.23` evaluates to about linear `0.04`.
- `diffuse_albedo = 0.46 0.46 0.46` evaluates to about linear `0.18`.

## Validation status

Still under validation. Before using it as a reference, compare against simple UE
Substrate Slab materials:

- dielectric Slab
- colored F0
- colored F90
- high roughness diffuse/specular
- Haziness / SecondRoughness
- clearcoat-like Haziness
- fuzz

The goal is not full UE parity; the goal is to match the local pixel-level terms
that can reasonably fit in `.brdf`.
