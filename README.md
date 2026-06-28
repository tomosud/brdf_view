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

| ファイル | 概要 |
|---|---|
| `sample/brdf/disney.brdf` | Disney principled BRDF風の独自サンプル。元ビューア実装そのものではありません。 |
| `sample/brdf/unreal_legacy_pbr.brdf` | Unreal legacy Default Lit のローカルBRDF近似。 |
| `sample/brdf/openpbr.brdf` | OpenPBR風の不透明反射近似。推定・代替が多いです。 |
| `sample/brdf/substrate.brdf` | Unreal Substrate Slab のローカルdirect lighting近似。 |

各項目が「そのまま実装」「代替」「省略」のどれかは
[PBR BRDF validation status](docs/pbr_brdf_validation_status.md) にまとめています。

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
