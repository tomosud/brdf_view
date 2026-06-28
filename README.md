# BRDF Explorer Web

Disney BRDF Explorer をブラウザで使えるようにした WebGL2 版です。
`.brdf` の GLSL 断片をそのまま shader template に注入し、複数のビューで
BRDF の形状や見た目を確認できます。

- Web app: https://tomosud.github.io/brdf_view/
- Windows comparison runtime: https://github.com/tomosud/brdf_view/releases/tag/brdf-runtime-v0.1.0

<img width="1700" height="899" alt="image" src="https://github.com/user-attachments/assets/30943e8d-63ab-4fca-9189-55b841eaeb76" />

## できること

- `.brdf` analytic BRDF を読み込んで表示できます。
- MERL `.binary` measured BRDF を読み込めます。
- 同梱 sample BRDF をアプリ内から選択して読み込めます。
- BRDF パラメータを調整しながら、複数ビューで比較できます。
- IndexedDB に前回セッションを保存し、再読み込み時に復元します。
- 元 Disney BRDF Explorer の Windows runtime を比較対象として使えます。

MERL BRDF Database の測定 BRDF は以下から入手できます。

https://www.merl.com/research/downloads/BRDF

## ビュー

- `3D Plot`: BRDF の形状を 3D で確認します。
- `Polar Plot`: 角度方向の分布を極座標で確認します。
- `Theta V / Theta H / Theta D`: Cartesian plot で角度スライスを確認します。
- `Image Slice`: half/difference angle の断面を画像または高さ表示で確認します。
- `Lit Object`: HDRI 環境光で球やティーポットを照らして確認します。
- `Lit Sphere`: 元 BRDF Explorer に近い球表示で確認します。

`ALBEDO` view は廃止しました。Monte Carlo 積分を含む巨大 shader が通常
`.brdf` の初回 compile を重くしていたため、現在の Cartesian plot は
`Theta V / Theta H / Theta D` のみです。

## 使い方

1. Web app を開きます。
2. `Open BRDF...` から `.brdf` または `.binary` ファイルを選びます。
3. サンプルを試す場合は `Load sample Brdf` を押して一覧から選びます。
4. 左側のパラメータで表示する BRDF を選び、値を調整します。

## 検証中の BRDF

以下の BRDF は検証中です。表示・比較には使えますが、仕様や参照実装と
数値的に完全一致しているとは限りません。結果が正しいとは限らないため、
比較・確認用として扱ってください。

- `sample/brdf/disney.brdf`
- `sample/brdf/unreal_legacy_pbr.brdf`
- `sample/brdf/openpbr.brdf`
- `sample/brdf/substrate.brdf`

詳細は [BRDF review](docs/brdf_review_2026-06-28.md) を参照してください。

### `sample/brdf/disney.brdf`

元 Disney BRDF Explorer の principled BRDF sample に近い参照用ファイルです。
Burley 2012 の diffuse retro-reflection、subsurface 近似、anisotropic GTR2、
sheen、GTR1 clearcoat を含みます。

WebGL2 版では GLSL ES 3.00 へ通すための互換変換が入るため、元アプリと
完全な数値一致までは保証していません。

### `sample/brdf/unreal_legacy_pbr.brdf`

Unreal Engine の Substrate 以前の legacy `DefaultLitBxDF` を、`.brdf` の
局所 BRDF に落とした近似実装です。UE の `BaseColor / Metallic / Specular /
Roughness` 入力を使い、Lambert diffuse と GGX specular を評価します。

含むもの:

- `ComputeF0`: `mix(0.08 * Specular, BaseColor, Metallic)`
- `ComputeDiffuseAlbedo`: `BaseColor * (1 - Metallic)`
- `D_GGX` / `D_GGXaniso`
- `Vis_SmithJointApprox` / `Vis_SmithJointAniso`
- UE の `F_Schlick` micro-occlusion
- optional rough diffuse
- optional analytic energy conservation

含まないもの:

- light falloff、shadow、`NoL` 乗算
- rect/area light LTC、IBL preintegrated GF
- clear coat、cloth、hair、eye、subsurface、transmission
- GBuffer packing や renderer-side override

詳細は [Unreal legacy PBR BRDF notes](docs/unreal_legacy_pbr_brdf.md) を参照してください。

### `sample/brdf/openpbr.brdf`

OpenPBR Surface の opaque reflection subset を `.brdf` フォーマットに落とした
近似実装です。

実装済み:

- Coat: isotropic GGX + IOR Fresnel
- Fuzz / Sheen: Charlie NDF + Ashikhmin visibility
- Thin-film: compact RGB thin-film Fresnel approximation
- Specular: anisotropic GGX
- Diffuse: EON-style rough diffuse approximation
- Metallic: base color による F0 tint

未対応または制約あり:

- transmission / subsurface / volume / emission は `.brdf` の局所反射関数では扱いません。
- thin-film と diffuse attenuation の結合、`specular_weight` との整合、rough diffuse
  の式はまだ検証中です。

### `sample/brdf/substrate.brdf`

Unreal Engine 5 Substrate の opaque Slab direct-lighting を、ピクセル単位の
`BRDF(L,V,N,X,Y)` で表せる範囲に落とした近似実装です。

含むもの:

- UE 由来の GGX / anisotropic GGX
- joint Smith visibility
- generalized Schlick Fresnel with F0/F90
- F90 normalization + F0 micro-occlusion
- analytic GGX energy preservation
- EON-style rough diffuse
- Haziness / SecondRoughness approximation
- deprecated Charlie/Ashikhmin fuzz fallback

含まないもの:

- Substrate graph topology / simplification / deferred storage
- SSS / MFP / transmission / rough refraction / thin surface
- glints / specular profile / Sheen LTC / area-light LTC
- path tracing, engine light/shadow integration, texture/LUT backed paths

詳細は [Substrate BRDF notes](docs/substrate_brdf.md) を参照してください。

## 開発

```powershell
cd web
npm install
npm run dev
```

Production build:

```powershell
cd web
npm run build
```

## Attribution

This project is based on the Disney BRDF Explorer.

Original project:

https://github.com/wdas/brdf

Original Disney BRDF Explorer files carry Disney Enterprises copyright and
license notices. Redistributed files should keep the bundled license and
attribution files.
