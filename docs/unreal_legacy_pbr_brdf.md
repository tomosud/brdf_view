# Unreal legacy Default Lit BRDF

対象ファイル: `sample/brdf/unreal_legacy_pbr.brdf`

このファイルは Unreal Engine の非Substrate Default Litに近いローカルBRDF。
完全なUnrealレンダラ実装ではない。

このツールで計算するのは次のローカル関数だけ。

```glsl
vec3 BRDF(vec3 L, vec3 V, vec3 N, vec3 X, vec3 Y)
```

ライトの強さ、ライト色、距離減衰、影、環境光、LUT、テクスチャ読み出し、
GBuffer、renderer view overrideは扱わない。
`NoL` の外側乗算もこの関数の外とする。

`color` パラメータはファイル内で `pow(color, 2.2)` によりリニア化する。

## パラメータ

| パラメータ | 範囲 / 既定値 | 内容と実装 |
|---|---:|---|
| `base_color` | color / `.82 .67 .16` | ベース色。拡散色と金属F0に使う。 |
| `metallic` | `0..1` / `0` | 拡散色を `base * (1 - metallic)` にし、F0をbase色へ寄せる。 |
| `specular` | `0..1` / `.5` | 誘電体F0。`0.08 * specular` として使う。 |
| `roughness` | `0..1` / `.5` | GGX粗さ。最小値 `0.001` に丸める。 |
| `anisotropy` | `-0.99..0.99` / `0` | 異方性GGXに切り替える。0付近では等方GGX。 |
| `rough_diffuse` | bool / `0` | `0` はLambert、`1` はEON系のrough diffuse。 |
| `energy_conservation` | bool / `0` | `1` で解析近似のGGXエネルギー補正を使う。 |

## 実装

- F0: `mix(vec3(0.08 * specular), base_color, metallic)`。
- 拡散色: `base_color * (1 - metallic)`。
- 拡散: Lambert、またはrough diffuse。
- スペキュラ: GGX NDF、joint Smith visibility、Schlick Fresnel。
- Fresnel: F0が低い場合はgrazing項にmicro-occlusionが掛かる。
- 異方性: `anisotropy` が0でない場合だけ異方性GGXを使う。
- energy conservation: 有効時はスペキュラを増やし、拡散を減らす解析近似。

## 省略

- clear coat、cloth、hair、eye、subsurface、two-sided foliage、transmission: 別モデルなので省略。
- light shape widening、rect light、area light、IBL: このツールでは扱わない。
- ライト減衰、ライト色、影、`NoL` 乗算: この関数の外。
- GBuffer packing、renderer view override: この関数では扱わない。

## 現状

Default Litの比較用として使う。
数値一致は未保証。
