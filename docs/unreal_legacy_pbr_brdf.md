# Unreal legacy PBR BRDF notes

This note documents
[`sample/brdf/unreal_legacy_pbr.brdf`](../sample/brdf/unreal_legacy_pbr.brdf).

The target is Unreal Engine's legacy, non-Substrate `DefaultLitBxDF`, reduced to
the local `.brdf` function:

```glsl
vec3 BRDF(vec3 L, vec3 V, vec3 N, vec3 X, vec3 Y)
```

## Sources checked

Local Unreal shader sources:

- `C:\work\unreal\Shaders\Private\ShadingModels.ush`
  - `DefaultLitBxDF`
  - `SpecularGGX`
- `C:\work\unreal\Shaders\Private\BRDF.ush`
  - `Diffuse_Lambert`
  - `Diffuse_GGX_Rough`
  - `D_GGX`
  - `D_GGXaniso`
  - `Vis_SmithJointApprox`
  - `Vis_SmithJointAniso`
  - `F_Schlick`
- `C:\work\unreal\Shaders\Private\ShadingCommon.ush`
  - `ComputeF0`
  - `ComputeDiffuseAlbedo`
  - `F0RGBToMicroOcclusion`
- `C:\work\unreal\Shaders\Private\ShadingEnergyConservation.ush`
  - optional analytic GGX energy path

## Scope

The implementation is the local direct-lighting BRDF part of legacy Default Lit.
It omits:

- light falloff, light color, shadows, and `NoL` multiplication
- `SphereMaxNoH` and punctual/area light shape widening
- rect light LTC
- IBL preintegrated GF
- clear coat, cloth, hair, eye, subsurface, two-sided foliage, transmission
- GBuffer packing and renderer view overrides

## Parameters

| Parameter | Meaning |
|---|---|
| `base_color` | UE material Base Color, stored as sRGB UI color and converted to linear. |
| `metallic` | UE material Metallic. |
| `specular` | UE material Specular. Dielectric F0 is `0.08 * specular`. |
| `roughness` | UE perceptual roughness. |
| `anisotropy` | Optional anisotropic GGX path. Default is 0, matching ordinary Default Lit. |
| `rough_diffuse` | Optional `MATERIAL_ROUGHDIFFUSE` path. Default off, matching the common legacy path. |
| `energy_conservation` | Optional analytic energy conservation/preservation path. Default off because legacy material energy conservation is project/platform controlled and off by default for non-Substrate paths in the checked source. |

## Implemented mapping

| UE behavior | Local implementation |
|---|---|
| `ComputeF0(Specular, BaseColor, Metallic)` | `mix(vec3(0.08 * specular), base_color, metallic)` after sRGB-to-linear conversion. |
| `ComputeDiffuseAlbedo(BaseColor, Metallic)` | `base_color * (1 - metallic)`. |
| Default diffuse | `Diffuse_Lambert`. |
| Optional rough diffuse | `Diffuse_GGX_Rough` version 3, using UE's EON-style approximation. |
| Isotropic specular | `D_GGX * Vis_SmithJointApprox * F_Schlick`. |
| Anisotropic specular | `D_GGXaniso * Vis_SmithJointAniso * F_Schlick`. |
| UE Schlick Fresnel | Includes F0 micro-occlusion: grazing term is `F0RGBToMicroOcclusion(F0)`, not always white. |
| Optional energy path | Analytic `USE_ENERGY_CONSERVATION == 2` approximation. |

## Validation status

This is under validation. It should be compared against UE legacy Default Lit
with simple punctual lights and material values:

- dielectric, `specular = 0.5`, `metallic = 0`
- metallic, `metallic = 1`
- low F0 / low specular to check micro-occlusion behavior
- roughness sweep
- anisotropy sweep
- optional `rough_diffuse` and `energy_conservation` toggles
