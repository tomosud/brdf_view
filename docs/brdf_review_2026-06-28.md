# BRDF implementation notes - 2026-06-28

対象:

- `sample/brdf/disney.brdf`
- `sample/brdf/unreal_legacy_pbr.brdf`
- `sample/brdf/openpbr.brdf`
- `sample/brdf/substrate.brdf`

このツールの `.brdf` は次の関数だけを計算する。

```glsl
vec3 BRDF(vec3 L, vec3 V, vec3 N, vec3 X, vec3 Y)
```

計算できるのは、1点のローカルな反射値だけ。
ライトの強さ、ライト色、距離減衰、影、環境光、画面空間効果、パストレーシング、
マテリアルグラフ、テクスチャ読み出し、LUT、GBuffer、レイヤーの非ローカルな合成は扱わない。
`NoL` の外側乗算もこの関数の外とする。

UI の `color` は各ファイル内で `pow(color, 2.2)` によりリニア値として使う。

## Disney principled BRDF

ファイル: `sample/brdf/disney.brdf`

位置づけ: Disney BRDF Explorer の principled BRDF サンプル。

### パラメータ

| パラメータ | 範囲 / 既定値 | 内容と実装 |
|---|---:|---|
| `baseColor` | color / `.82 .67 .16` | ベース色。拡散、金属F0、tint計算に使う。 |
| `metallic` | `0..1` / `0` | `0` は誘電体、`1` は金属。拡散を減らし、F0を `baseColor` に寄せる。 |
| `subsurface` | `0..1` / `0` | 通常拡散と簡易subsurface項を補間する。実際のSSSは計算しない。 |
| `specular` | `0..1` / `.5` | 誘電体F0の強さ。`0.08 * specular` として使う。 |
| `roughness` | `0..1` / `.5` | 拡散retro-reflection、GGX/GTR2粗さ、subsurface近似に使う。 |
| `specularTint` | `0..1` / `0` | 誘電体スペキュラ色をベース色の色相へ寄せる。 |
| `anisotropic` | `0..1` / `0` | 異方性。`X/Y` 方向のGTR2 alphaを変える。 |
| `sheen` | `0..1` / `0` | grazing方向のsheenを足す。 |
| `sheenTint` | `0..1` / `.5` | sheen色を白とベース色tintで補間する。 |
| `clearcoat` | `0..1` / `0` | clearcoat lobeの重み。 |
| `clearcoatGloss` | `0..1` / `1` | clearcoatの粗さ。GTR1のalphaを `.1..001` で補間する。 |

### 実装

- 拡散: Burley diffuse。
- subsurface: Hanrahan-Krueger型の簡易近似。
- スペキュラ: anisotropic GTR2、Schlick Fresnel、Smith GGX。
- sheen: Schlick Fresnelでgrazing方向に加算。
- clearcoat: GTR1、F0=0.04、固定Smith粗さ。

### 省略

- transmission: パラメータがないため省略。
- 実SSS: この関数では計算できないため簡易項のみ。
- 複数散乱GGX補正: このファイルにはない。
- IBL、area light、影、ライト減衰: このツールでは扱わない。

## Unreal legacy Default Lit

ファイル: `sample/brdf/unreal_legacy_pbr.brdf`

位置づけ: Unreal Engine の非Substrate Default Litに近いローカルBRDF。

### パラメータ

| パラメータ | 範囲 / 既定値 | 内容と実装 |
|---|---:|---|
| `base_color` | color / `.82 .67 .16` | ベース色。リニア化して拡散色と金属F0に使う。 |
| `metallic` | `0..1` / `0` | 拡散色を `base * (1 - metallic)` にし、F0をbase色へ寄せる。 |
| `specular` | `0..1` / `.5` | 誘電体F0。`0.08 * specular` として使う。 |
| `roughness` | `0..1` / `.5` | GGX粗さ。最小値 `0.001` に丸める。 |
| `anisotropy` | `-0.99..0.99` / `0` | 異方性GGXに切り替える。0付近では等方GGX。 |
| `rough_diffuse` | bool / `0` | `0` はLambert、`1` はEON系のrough diffuse。 |
| `energy_conservation` | bool / `0` | `1` で解析近似のGGXエネルギー補正を使う。 |

### 実装

- F0: `mix(vec3(0.08 * specular), base_color, metallic)`。
- 拡散色: `base_color * (1 - metallic)`。
- 拡散: Lambert、またはrough diffuse。
- スペキュラ: GGX NDF、joint Smith visibility、Schlick Fresnel。
- 異方性: `anisotropy` が0でない場合だけ異方性GGXを使う。
- energy conservation: 有効時はスペキュラを増やし、拡散を減らす解析近似。

### 省略

- clear coat、cloth、hair、eye、subsurface、two-sided foliage、transmission: 別モデルなので省略。
- area light / rect light、IBL、LUT、影、ライト減衰: このツールでは扱わない。
- エンジン側のマテリアル設定やGBuffer処理: この関数では扱わない。

## OpenPBR opaque subset

ファイル: `sample/brdf/openpbr.brdf`

位置づけ: OpenPBR風の不透明反射モデル。完全なOpenPBRではない。

### パラメータ

| パラメータ | 範囲 / 既定値 | 内容と実装 |
|---|---:|---|
| `base_color` | color / `.18 .18 .18` | ベース色。拡散色、金属F0、thin-film tintに使う。 |
| `base_weight` | `0..1` / `1` | 拡散項の重み。現在はスペキュラには掛けていない。 |
| `base_diffuse_roughness` | `0..1` / `0` | EON diffuseの粗さ。 |
| `base_metalness` | `0..1` / `0` | 誘電体F0と金属F0を補間し、拡散を減らす。 |
| `specular_color` | color / `1 1 1` | スペキュラ色。F0とthin-film結果に掛ける。 |
| `specular_weight` | `0..1` / `1` | 誘電体F0に掛ける。thin-film側との完全な対応は未確認。 |
| `specular_roughness` | `0..1` / `.3` | GGX粗さ。 |
| `specular_ior` | `1..3` / `1.5` | 誘電体F0とthin-film基材IORに使う。 |
| `specular_roughness_anisotropy` | `0..1` / `0` | 異方性GGXのalpha比に使う。 |
| `thin_film_weight` | `0..1` / `0` | 通常Schlick Fresnelとthin-film Fresnelを補間する。 |
| `thin_film_thickness` | `0..1.5` / `.5` | thin film厚み。単位はマイクロメートル扱い。 |
| `thin_film_ior` | `1..3` / `1.4` | thin film層のIOR。 |
| `coat_weight` | `0..1` / `0` | coat lobeの重み。下層を簡易減衰する。 |
| `coat_color` | color / `1 1 1` | coat lobeの色。 |
| `coat_roughness` | `0..1` / `0` | coat GGX粗さ。 |
| `coat_ior` | `1..3` / `1.6` | coat FresnelのF0に使う。 |
| `fuzz_weight` | `0..1` / `0` | fuzz lobeの重み。 |
| `fuzz_color` | color / `1 1 1` | fuzz色。 |
| `fuzz_roughness` | `0..1` / `.5` | Charlie NDFの粗さ。 |

### 実装

- レイヤー順: coat -> fuzz + specular + diffuse。
- 拡散: EON diffuse。金属では拡散を減らす。
- スペキュラ: anisotropic GGX、Smith visibility、Schlick Fresnel。
- thin film: RGB 3波長の簡易干渉Fresnel。通常Fresnelと重みで補間。
- coat: isotropic GGX。Fresnelで下層を簡易減衰。
- fuzz: Charlie NDF + Ashikhmin visibility。

### 不明 / 未確認

- OpenPBRのどの版の式へ完全一致させるかは未確定。
- `specular_weight` とthin-film Fresnelの対応は未確認。
- thin-film時の拡散減衰は通常Fresnel基準のまま。正しいか未確認。
- rough diffuse式が目的のOpenPBR式と一致するか未確認。

### 省略

- transmission、subsurface、volume、emission: このツールでは扱えないため省略。
- renderer closure、複数レイヤーの厳密なエネルギー交換: この関数では扱わない。

## Unreal Substrate Slab

ファイル: `sample/brdf/substrate.brdf`

位置づけ: Unreal Substrate Slabの不透明direct lighting近似。完全なSubstrateではない。

### パラメータ

| パラメータ | 範囲 / 既定値 | 内容と実装 |
|---|---:|---|
| `diffuse_albedo` | color / `.46 .46 .46` | 拡散色。EON diffuseに使う。 |
| `f0` | color / `.23 .23 .23` | 主スペキュラF0。リニア化して使う。 |
| `f90` | color / `1 1 1` | grazing色。最大RGBで正規化し、F0由来のmicro-occlusionを掛ける。 |
| `roughness` | `0..1` / `.45` | 主GGX粗さ。最小値 `0.001` に丸める。 |
| `anisotropy` | `-1..1` / `0` | 主GGXの異方性。負値ではX/Y方向を入れ替える。 |
| `second_roughness` | `0..1` / `.85` | 2つ目のスペキュラlobeの粗さ。 |
| `second_roughness_weight` | `0..1` / `0` | 主lobeと2つ目のlobeの混合量。 |
| `second_roughness_as_clearcoat` | bool / `0` | `1` で2つ目のlobeを簡易clearcoatとして扱う。 |
| `fuzz_amount` | `0..1` / `0` | fuzz lobeの重み。下層も減衰する。 |
| `fuzz_color` | color / `1 1 1` | fuzz FresnelのF0。 |
| `fuzz_roughness` | `0..1` / `.7` | fuzz粗さ。最小値 `0.05` に丸める。 |

### 実装

- 主スペキュラ: GGX、generalized Schlick、joint Smith visibility。
- 異方性: `anisotropy` の符号でalpha方向を変える。
- エネルギー補正: 解析近似でスペキュラを補正し、拡散透過量を作る。
- 拡散: rough diffuse。主スペキュラの残りとして減衰する。
- second roughness: 2つ目のGGX lobeとして混合。
- clearcoat扱い: `second_roughness_as_clearcoat` が有効ならF0=0.04の上層として簡易合成。
- fuzz: Charlie NDF、Ashikhmin visibility、簡易directional albedoで下層を減衰。

### 省略

- Substrate graph topology、closure packing、simplification: この関数では扱えない。
- LUT、area light、glints、specular profile、path tracing: このツールでは扱わない。
- MFP、SSS、thin surface、transmission、rough refraction: ローカルBRDFでは扱えないため省略。
- clearcoat時のbottom normalや厳密な透過: この実装では簡易化。

## 現状

| ファイル | 扱い |
|---|---|
| `disney.brdf` | 基準サンプルとして維持。 |
| `unreal_legacy_pbr.brdf` | Default Litの比較用。数値一致は未保証。 |
| `openpbr.brdf` | OpenPBR風の不透明近似。未確認項目が残る。 |
| `substrate.brdf` | Substrate Slabのローカル近似。エンジン全体のSubstrateではない。 |

