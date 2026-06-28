# Unreal Substrate Slab BRDF

対象ファイル: `sample/brdf/substrate.brdf`

このファイルは Unreal Substrate Slab の不透明direct lighting近似。
完全なSubstrate実装ではない。

このツールで計算するのは次のローカル関数だけ。

```glsl
vec3 BRDF(vec3 L, vec3 V, vec3 N, vec3 X, vec3 Y)
```

ライトの強さ、ライト色、距離減衰、影、環境光、LUT、テクスチャ読み出し、
マテリアルグラフ、GBuffer、path tracingは扱わない。

`color` パラメータはファイル内で `pow(color, 2.2)` によりリニア化する。

## パラメータ

| パラメータ | 範囲 / 既定値 | 内容と実装 |
|---|---:|---|
| `diffuse_albedo` | color / `.46 .46 .46` | 拡散色。EON diffuseに使う。 |
| `f0` | color / `.23 .23 .23` | 主スペキュラF0。リニア化して使う。既定値はリニアで約0.04。 |
| `f90` | color / `1 1 1` | grazing色。最大RGBで正規化し、F0由来のmicro-occlusionを掛ける。 |
| `roughness` | `0..1` / `.45` | 主GGX粗さ。最小値 `0.001` に丸める。 |
| `anisotropy` | `-1..1` / `0` | 主GGXの異方性。符号でX/Y方向を入れ替える。 |
| `second_roughness` | `0..1` / `.85` | 2つ目のスペキュラlobeの粗さ。 |
| `second_roughness_weight` | `0..1` / `0` | 主lobeと2つ目のlobeの混合量。 |
| `second_roughness_as_clearcoat` | bool / `0` | `1` で2つ目のlobeを簡易clearcoatとして扱う。 |
| `fuzz_amount` | `0..1` / `0` | fuzz lobeの重み。下層も減衰する。 |
| `fuzz_color` | color / `1 1 1` | fuzz FresnelのF0。 |
| `fuzz_roughness` | `0..1` / `.7` | fuzz粗さ。最小値 `0.05` に丸める。 |

## 実装

- 主スペキュラ: GGX、generalized Schlick、joint Smith visibility。
- 異方性: `anisotropy` の符号でalpha方向を変える。
- エネルギー補正: 解析近似でスペキュラを補正し、拡散透過量を作る。
- 拡散: rough diffuse。主スペキュラの残りとして減衰する。
- second roughness: 2つ目のGGX lobeとして混合する。
- clearcoat扱い: 有効時はF0=0.04の上層として簡易合成する。
- fuzz: Charlie NDF、Ashikhmin visibility、簡易directional albedoで下層を減衰する。

## 省略

- Substrate graph topology、closure packing、simplification: この関数では扱えない。
- MFP、SSS、thin surface、transmission、rough refraction: ローカルBRDFでは扱えない。
- LUT、area light、glints、specular profile、path tracing: このツールでは扱わない。
- clearcoat時のbottom normalや厳密な透過: この実装では簡易化。

## 現状

Substrate Slabのローカル近似として使う。
エンジン全体のSubstrateとは一致しない。
