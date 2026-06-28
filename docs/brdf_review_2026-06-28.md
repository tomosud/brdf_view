# BRDF review - Disney / OpenPBR / Unreal Substrate

Review date: 2026-06-28

Target files:

- [`sample/brdf/disney.brdf`](../sample/brdf/disney.brdf)
- [`sample/brdf/unreal_legacy_pbr.brdf`](../sample/brdf/unreal_legacy_pbr.brdf)
- [`sample/brdf/openpbr.brdf`](../sample/brdf/openpbr.brdf)
- [`sample/brdf/substrate.brdf`](../sample/brdf/substrate.brdf)

These files are validation targets. They are useful for visual comparison and
experimentation, but their output should not be treated as a guaranteed numeric
match to each model's official specification or renderer implementation.

## Current status

| File | Current judgment | Keep / change |
|---|---|---|
| `disney.brdf` | Closest to a reference sample. It is the original Disney BRDF Explorer principled BRDF style, with only WebGL compatibility handled by the viewer. | Keep as-is. |
| `unreal_legacy_pbr.brdf` | UE non-Substrate `DefaultLitBxDF` local BRDF approximation based on local shader sources. | New validation target. |
| `openpbr.brdf` | Useful opaque OpenPBR-style approximation, but still under validation. Thin-film coupling, `specular_weight`, and rough diffuse are the main suspicious areas. | Keep, but label as approximate. |
| `substrate.brdf` | UE5 Substrate Slab direct-lighting approximation for the `.brdf` local-function model. It now follows local UE shader source where possible. | Keep, but label as pixel-local approximation. |

## 1. Disney BRDF

`sample/brdf/disney.brdf` is essentially the original Disney BRDF Explorer
principled BRDF sample.

Important implemented behaviors:

- Burley diffuse retro-reflection:
  `Fd90 = 0.5 + 2 * LdotH^2 * roughness`
- Hanrahan-Krueger-style subsurface approximation used by the original sample
- anisotropic GTR2 / GGX specular
- sheen
- GTR1 clearcoat

Known limitations:

- No modern multiscatter GGX compensation. This is a property of the original
  sample, not a local regression.
- The Web viewer injects the BRDF into GLSL ES 3.00 templates and performs small
  compatibility rewrites, so exact byte-for-byte shader equivalence with the
  desktop application is not expected.
- It has not been exhaustively numerically compared against the desktop runtime
  for every parameter combination.

Recommendation: keep unchanged as the baseline sample.

## 2. Unreal legacy PBR BRDF

`sample/brdf/unreal_legacy_pbr.brdf` targets Unreal Engine's legacy
non-Substrate `DefaultLitBxDF`.

Relevant local Unreal shader sources checked:

- `C:\work\unreal\Shaders\Private\ShadingModels.ush`
- `C:\work\unreal\Shaders\Private\BRDF.ush`
- `C:\work\unreal\Shaders\Private\ShadingCommon.ush`
- `C:\work\unreal\Shaders\Private\ShadingEnergyConservation.ush`

Implemented local mapping:

| UE behavior | Local implementation |
|---|---|
| `ComputeF0` | `mix(vec3(0.08 * specular), base_color, metallic)` after sRGB-to-linear conversion. |
| `ComputeDiffuseAlbedo` | `base_color * (1 - metallic)`. |
| Default diffuse | `Diffuse_Lambert`. |
| Optional rough diffuse | `Diffuse_GGX_Rough` version 3 / EON-style approximation. |
| Isotropic specular | `D_GGX * Vis_SmithJointApprox * F_Schlick`. |
| Anisotropic specular | `D_GGXaniso * Vis_SmithJointAniso * F_Schlick`. |
| Optional energy path | Analytic approximation equivalent to UE `USE_ENERGY_CONSERVATION == 2`. |

Important differences from full UE:

- The `.brdf` returns BRDF value only, so light falloff, light color, shadows,
  and `NoL` multiplication are omitted.
- Area/rect light LTCs and `SphereMaxNoH` light-shape widening are omitted.
- IBL preintegrated GF is omitted.
- Clear coat, cloth, hair, eye, subsurface, two-sided foliage, and transmission
  are separate UE shading models and are not included.
- Legacy material energy conservation is project/platform controlled in UE; the
  `.brdf` exposes it as `energy_conservation`, defaulting to off.

Recommendation: keep as the UE legacy Default Lit comparison target, and compare
against punctual-light UE renders before treating it as numeric ground truth.

## 3. OpenPBR BRDF

`sample/brdf/openpbr.brdf` is an opaque reflection-only approximation inspired
by OpenPBR Surface. The `.brdf` format exposes only:

```glsl
vec3 BRDF(vec3 L, vec3 V, vec3 N, vec3 X, vec3 Y)
```

That makes transmission, subsurface, volume, emission, renderer closures, and
non-local transport out of scope.

### Implemented components

| Component | Local implementation |
|---|---|
| Base color / metalness | sRGB UI color converted to linear; metallic blends F0 toward base color. |
| Diffuse | EON-style rough diffuse approximation. |
| Specular | Anisotropic GGX with IOR-derived dielectric F0. |
| Thin film | Compact RGB three-layer Fresnel approximation. |
| Coat | Isotropic GGX lobe with IOR Fresnel and simple attenuation of lower layers. |
| Fuzz | Charlie NDF + Ashikhmin visibility. |

### Main validation risks

1. Thin-film diffuse attenuation

   The code computes `spec_F` from either Schlick or thin-film Fresnel:

   ```glsl
   vec3 spec_F = mix(std_F, tf_F, thin_film_weight);
   ```

   But diffuse attenuation still uses a non-thin-film dielectric Fresnel average:

   ```glsl
   float avg_specF = dot(fresnelSchlick(LdotH, f0_dielectric * specular_color_lin),
                         vec3(1.0 / 3.0));
   ```

   When thin film increases reflectance, the diffuse term may remain too strong.
   This can over-brighten some thin-film cases.

2. `specular_weight` consistency

   The standard Schlick path folds `specular_weight` into dielectric F0. The
   thin-film path currently does not apply the same weighting in an obviously
   equivalent way. This matters when `thin_film_weight > 0` and
   `specular_weight < 1`.

3. Rough diffuse formula

   The EON-style function is a compact approximation. It should be rechecked
   against the exact OpenPBR version intended for this file before calling it
   correct.

Recommendation: keep the file as an experimental OpenPBR-style BRDF, but do not
present it as a faithful OpenPBR implementation yet.

## 4. Unreal Substrate BRDF

Relevant local Unreal shader sources checked:

- `C:\work\unreal\Shaders\Private\Substrate\Substrate.ush`
- `C:\work\unreal\Shaders\Private\Substrate\SubstrateEvaluation.ush`
- `C:\work\unreal\Shaders\Private\BRDF.ush`
- `C:\work\unreal\Shaders\Private\ShadingCommon.ush`
- `C:\work\unreal\Shaders\Private\ShadingEnergyConservation.ush`
- `C:\work\unreal\Shaders\Private\ShadingEnergyConservationTemplate.ush`

The full UE Substrate implementation cannot be represented in a single `.brdf`
function. UE depends on material graph topology, packed BSDF storage, compile-time
permutations, LUT textures, area-light LTCs, path tracing paths, and integration
with the renderer. The local target is therefore:

> A single opaque Substrate Slab direct-lighting approximation using only
> pixel-local values available to `BRDF(L,V,N,X,Y)`.

### Implemented UE-inspired behavior

| UE behavior | Local implementation |
|---|---|
| `D_GGX` / `D_GGXaniso` | Ported as local GGX NDF functions. |
| `Vis_SmithJoint` / `Vis_SmithJointAniso` | Uses UE-style joint Smith visibility. |
| `F_Schlick(F0, F90, VoH)` | Used for primary and secondary specular lobes. |
| F90 handling | F90 is normalized by max RGB and multiplied by F0 micro-occlusion. |
| GGX energy conservation | Uses UE's analytic approximation path instead of LUT access. |
| `Diffuse_GGX_Rough` version 3 | Uses UE-style EON diffuse with `roughness * 0.4`. |
| Second Roughness / Weight | Treated as Haziness-like secondary lobe. |
| Clearcoat-like second roughness | Exposed as `second_roughness_as_clearcoat`. |
| Fuzz | Uses deprecated Charlie/Ashikhmin fallback plus lower-lobe attenuation. |

### Intentional differences from UE

- No current UE Sheen LTC texture path for fuzz.
- No GGX energy LUT texture.
- No area-light LTCs, rect/capsule light handling, or engine shadow terms.
- No glints, specular profile LUTs, SSS/MFP, thin surface, transmission, or
  rough refraction.
- No Substrate material graph simplification or closure layering beyond the
  local Slab approximation.
- Clearcoat-like Haziness does not fully reproduce bottom normal handling or
  `SimpleClearCoatTransmittance`.

### Review correction

An earlier review suspected F90 normalization might remove artist control.
After reading `Substrate.ush`, that concern is incorrect for the targeted UE
behavior: UE normalizes F90 by the largest RGB component during relevant
pack/unpack paths, then applies micro-occlusion derived from F0. The local file
should keep this behavior.

Recommendation: keep `substrate.brdf` as the UE-inspired local approximation,
and validate it visually against simple UE Slab materials.

## Recommended next actions

1. For `unreal_legacy_pbr.brdf`, compare against UE legacy Default Lit punctual-light renders.
2. For `substrate.brdf`, compare against UE Slab materials for dielectric,
   metallic-ish F0, colored F90, haziness, clearcoat-like haziness, and fuzz.
3. For `openpbr.brdf`, decide the exact OpenPBR revision/formula target before
   changing rough diffuse.
4. Fix OpenPBR thin-film attenuation and `specular_weight` consistency before
   treating the file as more than an approximation.
5. Keep `disney.brdf` as the stable reference sample.

## Source list

- Disney Principled BRDF - Burley 2012:
  https://media.disneyanimation.com/uploads/production/publication_asset/48/asset/s2012_pbs_disney_brdf_notes_v3.pdf
- OpenPBR Surface:
  https://academysoftwarefoundation.github.io/OpenPBR/
- EON diffuse - Portsmouth, Kutz, Hill:
  https://arxiv.org/abs/2410.18026
- Unreal Substrate documentation:
  https://dev.epicgames.com/documentation/en-us/unreal-engine/overview-of-substrate-materials-in-unreal-engine
- Local Unreal shader sources under `C:\work\unreal\Shaders`
