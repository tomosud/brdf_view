# PBR BRDF validation status

対象:

- `sample/brdf/disney.brdf`
- `sample/brdf/unreal_legacy_pbr.brdf`
- `sample/brdf/openpbr.brdf`
- `sample/brdf/substrate.brdf`

この文書は各 `.brdf` が何を実装し、何を代替し、何を省略したかをまとめる。

このツールで実行する入口は次の1関数だけ。

```glsl
vec3 BRDF(vec3 L, vec3 V, vec3 N, vec3 X, vec3 Y)
```

扱えるのは1点のローカルな反射値だけ。
ライトの強さ、ライト色、距離減衰、影、環境光、テクスチャ読み出し、LUT、
GBuffer、マテリアルグラフ、パストレーシング、非ローカルなレイヤー合成は扱わない。
`NoL` の外側乗算もこの関数の外とする。

`color` パラメータは各ファイル内で `pow(color, 2.2)` によりリニア値として使う。

## 表の読み方

| 列 | 意味 |
|---|---|
| 元モデルの扱い | 実際の元実装で確認できた内容、または式・仕様から推定した内容。 |
| 確度 | 高: 実装や式と対応が明確。中: 近いが完全一致は未確認。低: 推定または独自近似。 |
| この実装 | この `.brdf` での扱い。 |
| 判定 | `そのまま`、`代替`、`省略`、`独自` のどれか。 |

## `sample/brdf/disney.brdf`

位置づけ: Disney principled BRDF風の独自 `.brdf` サンプル。
元BRDF Explorerに同梱されていた実装そのものではない。

### パラメータ

| パラメータ | 範囲 / 既定値 | 内容 |
|---|---:|---|
| `baseColor` | color / `.82 .67 .16` | ベース色。拡散、金属F0、tint計算に使う。 |
| `metallic` | `0..1` / `0` | 拡散を減らし、F0を `baseColor` に寄せる。 |
| `subsurface` | `0..1` / `0` | 通常拡散と簡易subsurface項を補間する。 |
| `specular` | `0..1` / `.5` | 誘電体F0の強さ。`0.08 * specular` として使う。 |
| `roughness` | `0..1` / `.5` | 拡散retro-reflection、GTR2粗さ、subsurface近似に使う。 |
| `specularTint` | `0..1` / `0` | 誘電体スペキュラ色をベース色の色相へ寄せる。 |
| `anisotropic` | `0..1` / `0` | `X/Y` 方向のGTR2 alphaを変える。 |
| `sheen` | `0..1` / `0` | grazing方向のsheenを足す。 |
| `sheenTint` | `0..1` / `.5` | sheen色を白とベース色tintで補間する。 |
| `clearcoat` | `0..1` / `0` | clearcoat lobeの重み。 |
| `clearcoatGloss` | `0..1` / `1` | clearcoatの粗さ。GTR1のalphaを `.1..001` で補間する。 |

### 実装対応

| 項目 | 元モデルの扱い | 確度 | この実装 | 判定 |
|---|---|---:|---|---|
| diffuse | Burley diffuse retro-reflection。 | 高 | `Fd90 = 0.5 + 2 * LdotH^2 * roughness` を使う。 | 独自 |
| subsurface | Hanrahan-Krueger系の簡易BSSRDF近似。 | 中 | `subsurface` で通常拡散と簡易項を補間する。実SSSではない。 | 代替 |
| dielectric F0 | `specular` からF0を作る。 | 高 | `0.08 * specular`。`specularTint` で色を寄せる。 | 独自 |
| metallic | 金属では拡散を減らし、F0をベース色へ寄せる。 | 高 | `mix(dielectricF0, baseColor, metallic)` と `(1 - metallic)`。 | 独自 |
| specular lobe | 異方性GTR2/GGX系。 | 高 | `GTR2_aniso * Smith * Schlick`。 | 独自 |
| sheen | grazing方向の追加反射。 | 中 | `sheen * tint * SchlickFresnel(LdotH)` を加算。 | 独自 |
| clearcoat | GTR1 clearcoat。 | 高 | F0=0.04、GTR1、固定Smith粗さ。 | 独自 |
| multiple scattering | 現代的な複数散乱補正は別物。 | 高 | 実装なし。 | 省略 |
| transmission / real SSS | ローカルBRDFだけでは扱えない。 | 高 | 実装なし。 | 省略 |

## `sample/brdf/unreal_legacy_pbr.brdf`

位置づけ: Unreal Engine の非Substrate Default Litに近いローカルBRDF。
完全なUnrealレンダラ実装ではない。

### パラメータ

| パラメータ | 範囲 / 既定値 | 内容 |
|---|---:|---|
| `base_color` | color / `.82 .67 .16` | ベース色。拡散色と金属F0に使う。 |
| `metallic` | `0..1` / `0` | 拡散色を減らし、F0をbase色へ寄せる。 |
| `specular` | `0..1` / `.5` | 誘電体F0。`0.08 * specular` として使う。 |
| `roughness` | `0..1` / `.5` | GGX粗さ。最小値 `0.001` に丸める。 |
| `anisotropy` | `-0.99..0.99` / `0` | 異方性GGXに切り替える。 |
| `rough_diffuse` | bool / `0` | Lambertとrough diffuseを切り替える。 |
| `energy_conservation` | bool / `0` | 解析近似のGGXエネルギー補正を使う。 |

### 実装対応

| 項目 | 元モデルの扱い | 確度 | この実装 | 判定 |
|---|---|---:|---|---|
| F0 | `Specular`、`BaseColor`、`Metallic` から計算する。 | 高 | `mix(vec3(0.08 * specular), base_color, metallic)`。 | そのまま |
| diffuse albedo | 金属度で拡散色を減らす。 | 高 | `base_color * (1 - metallic)`。 | そのまま |
| default diffuse | legacy Default Litの通常経路はLambert。 | 高 | `rough_diffuse = 0` でLambert。 | そのまま |
| rough diffuse | rough diffuse経路がある。 | 中 | `rough_diffuse = 1` でEON系近似を使う。 | 代替 |
| isotropic specular | GGX NDF、joint Smith visibility、Schlick Fresnel。 | 高 | `D_GGX * Vis_SmithJointApprox * F_Schlick`。 | そのまま |
| anisotropic specular | 異方性GGX経路。 | 高 | `anisotropy != 0` で `D_GGXaniso * Vis_SmithJointAniso`。 | そのまま |
| Fresnel micro-occlusion | F0が低い場合、grazing項が常に白にならない。 | 高 | `F0RGBToMicroOcclusion` 相当を使う。 | そのまま |
| energy conservation | project/platformで変わる補正経路。 | 中 | UI boolで有効化する解析近似。既定はoff。 | 代替 |
| clear coat / cloth / hair / eye / SSS / transmission | Default Litとは別のモデル。 | 高 | 実装なし。 | 省略 |
| light shape / area light / IBL / shadow / GBuffer | レンダラ側の処理。 | 高 | 実装なし。 | 省略 |

## `sample/brdf/openpbr.brdf`

位置づけ: OpenPBR風の不透明反射モデル。
完全なOpenPBR実装ではない。

### パラメータ

| パラメータ | 範囲 / 既定値 | 内容 |
|---|---:|---|
| `base_color` | color / `.18 .18 .18` | ベース色。拡散色、金属F0、thin-film tintに使う。 |
| `base_weight` | `0..1` / `1` | 拡散項の重み。 |
| `base_diffuse_roughness` | `0..1` / `0` | diffuse粗さ。 |
| `base_metalness` | `0..1` / `0` | 誘電体F0と金属F0を補間し、拡散を減らす。 |
| `specular_color` | color / `1 1 1` | スペキュラ色。 |
| `specular_weight` | `0..1` / `1` | 誘電体F0に掛ける。 |
| `specular_roughness` | `0..1` / `.3` | GGX粗さ。 |
| `specular_ior` | `1..3` / `1.5` | 誘電体F0とthin-film基材IORに使う。 |
| `specular_roughness_anisotropy` | `0..1` / `0` | 異方性GGXのalpha比に使う。 |
| `thin_film_weight` | `0..1` / `0` | 通常Fresnelとthin-film Fresnelを補間する。 |
| `thin_film_thickness` | `0..1.5` / `.5` | thin film厚み。マイクロメートル扱い。 |
| `thin_film_ior` | `1..3` / `1.4` | thin film層のIOR。 |
| `coat_weight` | `0..1` / `0` | coat lobeの重み。 |
| `coat_color` | color / `1 1 1` | coat色。 |
| `coat_roughness` | `0..1` / `0` | coat GGX粗さ。 |
| `coat_ior` | `1..3` / `1.6` | coat FresnelのF0に使う。 |
| `fuzz_weight` | `0..1` / `0` | fuzz lobeの重み。 |
| `fuzz_color` | color / `1 1 1` | fuzz色。 |
| `fuzz_roughness` | `0..1` / `.5` | Charlie NDFの粗さ。 |

### 実装対応

| 項目 | 元モデルの扱い | 確度 | この実装 | 判定 |
|---|---|---:|---|---|
| layer order | coat、fuzz、specular、diffuseを持つ。厳密な合成はrenderer closure依存。 | 中 | `coat + coat_attn * (diffuse + specular + fuzz)`。 | 代替 |
| base color / metalness | base色とmetalnessで拡散と金属反射を変える。 | 中 | 金属では拡散を減らし、F0をbase色へ寄せる。 | 代替 |
| diffuse | rough diffuseを持つ。正確な対象式は未固定。 | 低 | EON diffuse近似。 | 代替 |
| specular | IOR、色、粗さ、異方性を持つ。 | 中 | anisotropic GGX、Smith visibility、Schlick Fresnel。 | 代替 |
| `specular_weight` | specular強度を制御する。 | 低 | 通常F0には掛ける。thin-film側との整合は未確認。 | 代替 |
| thin film | 薄膜干渉を持つ。 | 中 | RGB 3波長の簡易thin-film Fresnel。 | 代替 |
| thin-film diffuse attenuation | 薄膜反射が拡散にも影響する可能性がある。 | 低 | 拡散減衰は通常Fresnel基準のまま。 | 代替 |
| coat | coat層を持つ。 | 中 | isotropic GGX + IOR Fresnel。下層は簡易減衰。 | 代替 |
| fuzz | fuzz/sheen系のlobeを持つ。 | 中 | Charlie NDF + Ashikhmin visibility。 | 代替 |
| transmission / subsurface / volume / emission | OpenPBRには該当要素がある。 | 高 | ローカル反射関数では扱えない。 | 省略 |
| renderer closure / energy exchange | renderer側のclosure合成が必要。 | 高 | 実装なし。 | 省略 |

## `sample/brdf/substrate.brdf`

位置づけ: Unreal Substrate Slabの不透明direct lighting近似。
完全なSubstrate実装ではない。

### パラメータ

| パラメータ | 範囲 / 既定値 | 内容 |
|---|---:|---|
| `diffuse_albedo` | color / `.46 .46 .46` | 拡散色。 |
| `f0` | color / `.23 .23 .23` | 主スペキュラF0。既定値はリニアで約0.04。 |
| `f90` | color / `1 1 1` | grazing色。正規化してmicro-occlusionを掛ける。 |
| `roughness` | `0..1` / `.45` | 主GGX粗さ。最小値 `0.001` に丸める。 |
| `anisotropy` | `-1..1` / `0` | 主GGXの異方性。 |
| `second_roughness` | `0..1` / `.85` | 2つ目のスペキュラlobeの粗さ。 |
| `second_roughness_weight` | `0..1` / `0` | 主lobeと2つ目のlobeの混合量。 |
| `second_roughness_as_clearcoat` | bool / `0` | 2つ目のlobeを簡易clearcoatとして扱う。 |
| `fuzz_amount` | `0..1` / `0` | fuzz lobeの重み。下層も減衰する。 |
| `fuzz_color` | color / `1 1 1` | fuzz FresnelのF0。 |
| `fuzz_roughness` | `0..1` / `.7` | fuzz粗さ。最小値 `0.05` に丸める。 |

### 実装対応

| 項目 | 元モデルの扱い | 確度 | この実装 | 判定 |
|---|---|---:|---|---|
| Slab specular | GGXまたは異方性GGX。 | 高 | GGX / anisotropic GGX。 | そのまま |
| visibility | joint Smith visibility。 | 高 | `Vis_SmithJoint` / `Vis_SmithJointAniso` 相当。 | そのまま |
| Fresnel | F0/F90のgeneralized Schlick。 | 高 | `fresnelSchlick(VoH, F0, F90)`。 | そのまま |
| F90 | 最大RGBで正規化し、F0由来のmicro-occlusionを掛ける。 | 高 | `normalizeF90(f90) * F0RGBToMicroOcclusion(F0)`。 | そのまま |
| energy preservation | LUTまたは解析近似の経路がある。 | 中 | 解析近似のみ。LUTは使わない。 | 代替 |
| diffuse | rough diffuse。 | 中 | EON系rough diffuseを `roughness * 0.4` で使う。 | 代替 |
| second roughness | Haziness / second roughness系の追加lobe。 | 中 | 2つ目のGGX lobeとして混合。 | 代替 |
| clearcoat-like second lobe | clearcoat的な上層扱いがある。 | 低 | F0=0.04、F90=1.0の簡易上層として合成。 | 代替 |
| fuzz | fuzz/sheen系処理。 | 低 | Charlie NDF + Ashikhmin visibility、下層を簡易減衰。 | 代替 |
| graph topology / closure packing | Substrateの中核。 | 高 | 単一関数では扱えない。 | 省略 |
| MFP / SSS / thin surface / transmission / rough refraction | 非ローカルまたは別経路が必要。 | 高 | 実装なし。 | 省略 |
| area light / glints / specular profile / path tracing | renderer側の処理。 | 高 | 実装なし。 | 省略 |

## 現状

| ファイル | 扱い |
|---|---|
| `disney.brdf` | Disney principled BRDF風の独自サンプル。 |
| `unreal_legacy_pbr.brdf` | Default Litの比較用。主要なローカルBRDF項は実装。 |
| `openpbr.brdf` | OpenPBR風の不透明近似。推定・代替が多い。 |
| `substrate.brdf` | Substrate Slabのローカル近似。renderer依存部分は省略。 |
