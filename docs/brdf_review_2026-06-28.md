# BRDF review - Disney / OpenPBR / Unreal Substrate

Review date: 2026-06-28

Target files:

- [`sample/brdf/disney.brdf`](../sample/brdf/disney.brdf)
- [`sample/brdf/openpbr.brdf`](../sample/brdf/openpbr.brdf)
- [`sample/brdf/substrate.brdf`](../sample/brdf/substrate.brdf)

This review was updated after checking the local Unreal shader sources under
`C:\work\unreal\Shaders`.

## Summary

| File | Status | Notes |
|---|---|---|
| `disney.brdf` | Reference-style port | Matches the Disney BRDF Explorer sample closely. Keep as-is. |
| `openpbr.brdf` | Useful but still under validation | Layer structure is reasonable. Thin-film/diffuse energy coupling and diffuse roughness remain the main suspicious areas. |
| `substrate.brdf` | Reworked to a UE Slab direct-lighting approximation | Now follows UE's GGX, joint Smith visibility, generalized Schlick, F90 normalization, Haziness/SecondRoughness, analytic energy preservation, and fuzz lower-lobe attenuation where possible. |

## 1. Disney BRDF

`sample/brdf/disney.brdf` is essentially the original Disney BRDF Explorer
principled BRDF. The important behaviors match the Burley 2012 model:

- diffuse retro-reflection with `Fd90 = 0.5 + 2 * LdotH^2 * roughness`
- subsurface approximation from the original sample
- anisotropic GTR2/GGX specular
- sheen
- GTR1 clearcoat

Known limitation: it does not include modern multiscatter GGX compensation. That
is a property of the original sample, not a bug in this port.

Recommendation: no change.

## 2. Unreal Substrate BRDF

Relevant Unreal sources checked:

- `C:\work\unreal\Shaders\Private\Substrate\Substrate.ush`
- `C:\work\unreal\Shaders\Private\Substrate\SubstrateEvaluation.ush`
- `C:\work\unreal\Shaders\Private\BRDF.ush`
- `C:\work\unreal\Shaders\Private\ShadingCommon.ush`
- `C:\work\unreal\Shaders\Private\ShadingEnergyConservation.ush`
- `C:\work\unreal\Shaders\Private\ShadingEnergyConservationTemplate.ush`

The full UE implementation cannot be copied directly into this `.brdf` format:
it depends on engine storage, compile-time permutations, LUT textures, area-light
LTCs, material topology, path tracing, and participating-media code. The useful
target for this repository is therefore a single opaque Slab direct-lighting
BRDF.

### 2.1 What changed in `substrate.brdf`

The implementation now mirrors the following UE paths:

| UE source behavior | Local implementation |
|---|---|
| `D_GGX` / `D_GGXaniso` | Ported as local GGX NDF functions. |
| `Vis_SmithJoint` / `Vis_SmithJointAniso` | Replaced the previous separable visibility with UE's joint Smith visibility. |
| `F_Schlick(F0, F90, VoH)` | Used for the Slab specular lobes. |
| `F90 *= F0RGBToMicroOcclusion(F0)` | Applied after normalizing F90 by max RGB, matching UE's F90 handling. |
| `ComputeGGXSpecEnergyTerms` | Approximated with UE's analytic energy path instead of LUT sampling. |
| `Diffuse_GGX_Rough` version 3 | Uses UE's EON-style diffuse approximation with `roughness * 0.4`. |
| `SecondRoughness/Weight` | Treated as UE Haziness: a secondary specular lobe mixed by weight, not as an unrelated add-on. |
| `SecondRoughnessAsSimpleClearCoat` | Added as `second_roughness_as_clearcoat` for the simplified top-clearcoat mode. |
| Fuzz | Uses the deprecated Charlie/Ashikhmin path plus UE-style attenuation of lower diffuse/specular lobes. |

### 2.2 Remaining differences from UE

These are intentional constraints of the `.brdf` viewer:

- No `SheenLTCTexture`, so current UE fuzz LTC is approximated with the older
  Charlie/Ashikhmin fallback.
- No GGX energy LUT texture, so the analytic approximation path is used.
- No area-light LTC, rect/capsule light handling, or engine shadow terms.
- No glints, specular profile LUTs, SSS/MFP, thin surfaces, rough refraction,
  material graph topology, or simplification pipeline.
- Clearcoat-style Haziness is only approximated; UE's
  `SimpleClearCoatTransmittance` and bottom-normal handling are not fully
  reproduced.

### 2.3 Review correction

The earlier review treated F90 normalization as a possible loss of brightness
control. After reading `Substrate.ush`, that conclusion should be corrected:
UE itself normalizes F90 by its largest RGB component during unpack/bake paths,
then applies micro-occlusion from F0. The local implementation should keep that
behavior.

## 3. OpenPBR BRDF

`sample/brdf/openpbr.brdf` remains useful, but it should still be treated as
under validation.

### 3.1 Thin-film

The three-layer Airy-style `thinFilmFresnel` function is structurally
reasonable for a compact RGB approximation. The concern is not the thin-film
formula itself.

The larger issue is coupling:

```glsl
vec3 spec_F = mix(std_F, tf_F, thin_film_weight);
float avg_specF = dot(fresnelSchlick(LdotH, f0_dielectric * specular_color_lin), vec3(1.0 / 3.0));
```

When thin-film increases the specular reflectance, diffuse attenuation still
uses the non-thin-film Fresnel. That can make thin-film configurations too
bright. A likely correction is to base diffuse attenuation on `spec_F` or a
directional-albedo approximation derived from it.

### 3.2 `specular_weight`

The standard Fresnel path folds `specular_weight` into `f0_dielectric`, but the
thin-film path does not multiply by `specular_weight`. This only appears when
`thin_film_weight > 0` and `specular_weight < 1`, but it is a real inconsistency.

### 3.3 Diffuse roughness

The previous review's EON numeric note was too narrow. UE's current EON-style
diffuse in `BRDF.ush` is not the same as the simple polynomial used in
`openpbr.brdf`. The issue is therefore not just one coefficient: the whole
rough-diffuse approximation should be rechecked against the intended OpenPBR
version before making a "correct" fix.

## 4. Recommended next actions

1. Validate the new `substrate.brdf` visually against UE Slab presets for a few
   simple cases: dielectric, colored F90, hazy gloss, fuzz, and clearcoat-like
   haziness.
2. For OpenPBR, first fix thin-film diffuse attenuation and `specular_weight`
   consistency.
3. Revisit OpenPBR diffuse roughness only after choosing the exact intended EON
   or OpenPBR reference formula.
4. Keep `disney.brdf` unchanged as the original BRDF Explorer reference sample.

## 5. Source list

- Disney Principled BRDF - Burley 2012:
  https://media.disneyanimation.com/uploads/production/publication_asset/48/asset/s2012_pbs_disney_brdf_notes_v3.pdf
- OpenPBR Surface specification:
  https://academysoftwarefoundation.github.io/OpenPBR/
- EON diffuse - Portsmouth, Kutz, Hill:
  https://arxiv.org/abs/2410.18026
- Unreal Substrate documentation:
  https://dev.epicgames.com/documentation/en-us/unreal-engine/overview-of-substrate-materials-in-unreal-engine
- Local Unreal shader sources under `C:\work\unreal\Shaders`
