# Review of `sample/brdf/openpbr.brdf`

Date: 2026-07-04

## Scope and Assumptions

This is a static correctness review of `sample/brdf/openpbr.brdf` against the two local OpenPBR references supplied for review:

- `C:\work\openPBR\OpenPBR-viewer-main`
- `C:\work\openPBR\openpbr-bsdf-main`

I treated `openpbr-bsdf-main` as the more authoritative reference because its README describes it as a self-contained Adobe OpenPBR 1.1 BSDF implementation. I treated `OpenPBR-viewer-main` as a useful GLSL example implementation, but it targets OpenPBR Surface v1.2 and includes renderer/path-tracing features that cannot be represented by a single `.brdf` function.

The reviewed file is a local analytic BRDF sample, not a full renderer closure. Therefore some omissions are expected. The question here is whether it is correct as an OpenPBR opaque local-reflection implementation. My conclusion: it is not correct enough to call an OpenPBR implementation. It is better described as an OpenPBR-inspired visual approximation.

I did not modify `sample/brdf/openpbr.brdf`, and I did not run visual or shader-compile comparisons. This report is based on source inspection.

## Files Examined

Reviewed implementation:

- `C:\work\script\brdf_view\sample\brdf\openpbr.brdf`
- `C:\work\script\brdf_view\README.md`
- `C:\work\script\brdf_view\docs\pbr_brdf_validation_status.md`

Reference: `OpenPBR-viewer-main`

- `README.md`
- `main.js`
- `glsl\pathtracing\main.glsl`
- `glsl\pathtracing\openpbr_surface.glsl`
- `glsl\pathtracing\specular_brdf.glsl`
- `glsl\pathtracing\metal_brdf.glsl`
- `glsl\pathtracing\diffuse_brdf.glsl`
- `glsl\pathtracing\coat_brdf.glsl`
- `glsl\pathtracing\fuzz_brdf.glsl`
- `glsl\pathtracing\thin-film.glsl`

Reference: `openpbr-bsdf-main`

- `README.md`
- `openpbr_resolved_inputs.h`
- `impl\openpbr_bsdf.h`
- `impl\openpbr_lobe_utils.h`
- `impl\openpbr_vndf_microfacet_distribution.h`
- `impl\openpbr_comprehensive_microfacet_lobe.h`
- `impl\openpbr_reflection_transmission_coefficient.h`
- `impl\openpbr_thin_film_iridescence_utils.h`
- `impl\openpbr_diffuse_lobe.h`
- `impl\openpbr_coating_lobe.h`
- `impl\openpbr_fuzz_lobe.h`

## Verdict

`sample/brdf/openpbr.brdf` is acceptable only as a compact, educational, opaque BRDF approximation. It should not be validated as a faithful OpenPBR port.

The file captures a few broad ideas: GGX specular, rough diffuse, metalness suppressing diffuse, coat/fuzz-style extra lobes, and thin-film coloration. However, several core OpenPBR mechanisms are replaced by unrelated or older approximations, and some layer semantics are inverted.

## Major Findings

### 1. Layer order is wrong

`openpbr.brdf` documents and implements `Coat -> Fuzz -> Thin-film -> Specular + Diffuse`, then returns:

```glsl
coat_brdf + coat_attn * (diff_brdf + spec_brdf + fuzz_brdf)
```

In both references, fuzz/sheen is the outermost layer over the coated/base material. In `openpbr-bsdf-main`, the prepared lobe is structurally `fuzz_lobe.coating_lobe.base_lobe`, and `impl\openpbr_fuzz_lobe.h` attenuates the coating/base lobe by the fuzz layer's incoming/outgoing reflected proportions. In the viewer, `openpbr_surface.glsl` first computes a fuzz albedo and uses it to reduce the coated base before adding coat/base weights.

Impact: the current implementation lets coat attenuate fuzz, while OpenPBR has fuzz attenuating coat and base. This changes mixed coat+fuzz materials substantially.

### 2. Coat color and attenuation semantics are incorrect

`openpbr.brdf` multiplies the coat reflection by `coat_color` and attenuates the base by a scalar Schlick factor:

```glsl
coat_weight * coat_color_lin * coat_Fr * ...
coat_attn = 1.0 - coat_weight * coat_Fr
```

In the BSDF reference, coat reflection is dielectric reflection from `coat_ior`; `coat_color` is used as an absorption/transmission tint for passages through the coat. `impl\openpbr_coating_lobe.h` takes the square root of the tint, applies angle-dependent path length, and applies both incoming and outgoing base-layer scales. `impl\openpbr_bsdf.h` also computes coat darkening from internal reflection terms and base albedo.

Impact: tinted coats will be visibly wrong. The current code tints the reflected highlight directly and does not reproduce OpenPBR's coat darkening or two-pass absorption.

### 3. Metallic Fresnel is not OpenPBR

For metalness, `openpbr.brdf` blends to:

```glsl
base_color_lin * specular_color_lin
```

and evaluates it with ordinary Schlick Fresnel. It also drops `specular_weight` for fully metallic materials except through thin-film paths.

The references do not do this. The viewer's `metal_brdf.glsl` uses `FresnelF82Tint(base_weight * base_color, specular_color)` and multiplies the final conductor reflection by `specular_weight`. The BSDF reference uses `openpbr_metal_schlick_with_f82_tint`, `openpbr_metal_average_fresnel_with_f82_tint`, and `darkened_metal = base_metalness * specular_weight`.

Impact: metals will have the wrong edge behavior, wrong average energy, and wrong response to `specular_weight`.

### 4. Specular anisotropy mapping uses the Disney formula, not OpenPBR

`openpbr.brdf` maps anisotropy with:

```glsl
aspect = sqrt(1.0 - anisotropy * 0.9)
ax = roughness^2 / aspect
ay = roughness^2 * aspect
```

Both references use the OpenPBR formula:

```glsl
alpha_x = alpha * sqrt(2 / (1 + (1 - anisotropy)^2))
alpha_y = (1 - anisotropy) * alpha_x
```

Impact: anisotropic highlights will have different aspect ratios from OpenPBR.

### 5. Diffuse EON implementation is not the referenced EON model

`openpbr.brdf` uses a compact rough diffuse approximation with `sigma2 = roughness^2`, a simple average-energy scalar, and no dependence on diffuse albedo inside the multiscattering term.

The references use the Portsmouth/Hill/Kutz EON/FON formulation: `f_EON(rho, roughness, wi, wo)` with FON constants, directional albedos for both directions, albedo-dependent multiscattering, and in `openpbr-bsdf-main` an additional specular energy compensation lookup for the diffuse lobe.

Impact: rough diffuse energy and color behavior will not match, especially for saturated base colors and high diffuse roughness.

### 6. Fuzz is an older Charlie/Ashikhmin approximation, not OpenPBR fuzz

`openpbr.brdf` uses a Charlie NDF and Ashikhmin-style visibility term.

Both references implement fuzz/sheen as a Zeltner/Burley/Chiang LTC sheen layer with directional albedo and layer attenuation. The viewer uses rational fits in `fuzz_brdf.glsl`; the BSDF reference uses the LTC table/fetch path in `impl\openpbr_fuzz_lobe.h`.

Impact: fuzz lobe shape, brightness, view-angle response, and interaction with lower layers are not OpenPBR.

### 7. Thin-film implementation is only a rough dielectric RGB shortcut

The current thin-film code uses three fixed representative wavelengths and a simplified dielectric stack. For metallic surfaces it tints the dielectric thin-film result by base/specular color.

The references compute thin film over dielectric and conductor substrates differently. `openpbr-bsdf-main` computes both dielectric and metal thin-film reflectance with separate substrate handling, a thickness-based presence multiplier, and wavelength inputs. The viewer path tracer evaluates at a sampled hero wavelength and maps conductor color to complex IOR via Gulbrandsen-style metal parameters.

Impact: thin film over metal is not correct, high-frequency spectral behavior is not represented, and very thin films do not fade according to the reference presence multiplier.

### 8. Missing OpenPBR parameters are more than cosmetic

The reviewed `.brdf` intentionally omits transmission, subsurface, emission, volume, and opacity. That is reasonable for a local opaque BRDF sample. But it also omits parameters that affect opaque reflection in the references:

- `coat_darkening`
- `coat_roughness_anisotropy`
- coat and specular anisotropy rotation
- `specular_haze` and `specular_retroreflectivity` from the viewer's v1.2 path
- geometry/coat basis distinction
- roughness adjustments caused by coat and fuzz
- microfacet multiple-scattering compensation for base specular/metal

Impact: even when all transmission/SSS/emission controls are zero, many opaque OpenPBR materials cannot be matched.

## Things That Are Reasonable

- The parameter names and defaults are mostly aligned with `openpbr_resolved_inputs.h` for the subset it exposes.
- The file clearly states that transmission, subsurface, and emission are omitted.
- The GGX NDF and separable Smith visibility are plausible for a compact BRDF Explorer sample.
- The `thin_film_thickness` default and micrometer-to-nanometer conversion are consistent with the BSDF reference's `thin_film_thickness * 1000` path, although not with the viewer UI's nanometer-style default.

## Recommendation for the Implementing AI

Do not patch this implementation incrementally if the goal is correctness. Rebuild the opaque reflection approximation around the reference lobe structure:

1. Use the outer-to-inner order `fuzz -> coat -> base`.
2. Implement OpenPBR anisotropic alpha mapping exactly.
3. Split base reflection into dielectric and metallic behavior instead of one mixed F0.
4. Use F82-tint metallic Fresnel and apply `specular_weight` to metal.
5. Replace the diffuse function with the referenced EON/FON formula.
6. Replace Charlie fuzz with the viewer's rational LTC approximation if table LUTs are undesirable.
7. Treat `coat_color` as transmission tint, not reflected highlight color.
8. Either remove thin-film-over-metal support from the claim, or port the reference conductor thin-film path.

If the project only needs a lightweight visual sample, keep the implementation but rename/document it as an "OpenPBR-inspired opaque approximation" and avoid claims of OpenPBR correctness.

---

# Implementation Report (2026-07-04, same day)

`sample/brdf/openpbr.brdf` was rebuilt from scratch against the two references,
following the "Recommendation for the Implementing AI" above. The implementing
session independently re-verified all 8 major findings against the reference
sources before rewriting; all were confirmed valid.

## Independent verification notes

- Findings 1-8: confirmed by direct source inspection of
  `OpenPBR-viewer-main/glsl/pathtracing/*.glsl` and `openpbr-bsdf-main/impl/*.h`.
- One addition to Finding 3/8: the viewer's `openpbr_surface.glsl` multiplies the
  dielectric specular lobe weight by `specular_weight` *and* evaluates
  `FresnelDielectricReflectanceModulated` (which already folds `specular_weight`
  into F0 via the modified IOR, PR #247). That double-applies the weight.
  The Adobe implementation (`openpbr_apply_specular_weight_to_ior`) and the spec
  apply it once, via the IOR modulation only. The rebuild follows Adobe/spec:
  `w_spec = specular_color * w_dielectric` and the modulated Fresnel carries
  the weight.

## What the rebuild implements

| Finding | Resolution |
|---|---|
| 1. Layer order | `fuzz -> coat -> base` exactly as `openpbr_lobe_weights`: `w_coated_base = mix(1, 1-E_fuzz(V), F)`, `w_base = w_coated_base * mix(1, darkening * coat_color * (1-E_coat(V)), C)` |
| 2. Coat semantics | Coat reflection untinted (exact dielectric Fresnel at `coat_ior`); `coat_color` = transmission tint; PR #253 darkening implemented in full (`DielectricFresnelAvg`, `Kr`, `Ks`, roughness-blended `K`, base-albedo feedback `Delta`); new `coat_darkening` parameter (default 1) |
| 3. Metal Fresnel | `FresnelF82Tint(VoH, base_weight*base_color, specular_color)` with PR #256 clamp; `min(1, specular_weight * F)` as in `metal_brdf.glsl` |
| 4. Anisotropy | OpenPBR mapping: `alpha_x = r^2 * sqrt(2/(1+(1-a)^2))`, `alpha_y = (1-a) * alpha_x`, min 1e-4 |
| 5. Diffuse EON | Full EON (exact FON albedo `E_FON_exact`, `constant1_FON`, `constant2_FON`), evaluated white with color in the lobe weight, exactly as `diffuse_brdf.glsl` / `f_EON(vec3(1),...)` |
| 6. Fuzz | Zeltner sheen LTC via the viewer's rational fits (`zeltner_sheen_dir_albedo`, `ltc_aInv/bInv`), full LTC evaluation in the view-azimuth frame; layer attenuation by `1 - E_fuzz(V)` |
| 7. Thin film | Complex-arithmetic 6-step Airy summation ported from `thin-film.glsl` (Kutz & Portsmouth); dielectric substrate `(specular_ior, 0)`; conductor substrate via Gulbrandsen F0/edgetint -> (n,k) mapping; film exterior IOR blends with coat (`eta_fe`); evaluated at RGB wavelengths 630/532/450 nm as an RGB approximation of hero-wavelength sampling |
| 8. Missing params | `coat_darkening` added. Still omitted (documented in the file header): transmission, subsurface, emission, coat anisotropy/rotations, specular haze, retroreflectivity, dispersion |

Additional correctness upgrades over the old file:

- GGX shadowing-masking switched from separable Smith to height-correlated
  Smith (`ggx_G2` lambda form), matching the viewer.
- Diffuse energy coupling now uses `1 - E_spec(V)` with F0 including both the
  `specular_weight` modulation and (when enabled) the thin-film normal-incidence
  reflectance, so enabling thin film correctly reduces the diffuse lobe.
- Dielectric Fresnel is the exact unpolarized formula (not Schlick), with the
  PR #247 modulated-IOR path including the TIR-side Stokes reciprocity branch.

## Analytic substitutions (documented deviations)

A single pixel-local `BRDF()` cannot Monte-Carlo-sample lobe albedos as the
viewer does. The rebuild substitutes:

- `E_coat(V)`, `E_spec(V)`: analytic GGX split-sum directional albedo fit
  (the UE `ShadingEnergyConservation` analytic path, `USE_ENERGY_CONSERVATION==2`).
- `E_fuzz(V)`: the viewer's own `zeltner_sheen_dir_albedo` rational fit (exact match).
- Thin film: 3 fixed RGB wavelengths instead of spectral hero-wavelength sampling
  (banding for very thick films is expected and accepted).

## Numerical verification (Node.js mirror of the GLSL)

| Test | Result |
|---|---|
| Airy `thinFilmR` at d=0 equals plain dielectric Fresnel (n1->n3) | max diff 5.6e-17 |
| EON white, r=0 equals Lambert 1/pi | exact |
| EON white furnace (r=1, hemispherical albedo) | 1.0000 at NoV=1.0 and NoV=0.3 |
| Fuzz LTC hemispherical integral vs directional albedo (r=0.5) | 0.0317/0.0317, 0.1497/0.1497 |
| Default params energy sanity (w_diff <= base albedo) | pass |
| F82-tint with white tint reduces to Schlick; F(mu=1)=F0 | exact |

Build: `npm run build` pass; `web/public/brdfs` and `web/dist/brdfs` synced.
