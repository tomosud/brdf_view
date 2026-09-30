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
- RGL-EPFL `.bsdf` measured BRDF（RGB 版）を読み込めます。異方性データにも対応しています。
- 同梱 sample BRDF をアプリ内から選択して読み込めます。
- BRDF パラメータを調整しながら、複数ビューで比較できます。
- IndexedDB に前回セッションを保存し、再読み込み時に復元します。
- 元 Disney BRDF Explorer の Windows runtime を比較対象として使えます。

MERL BRDF Database の測定 BRDF は以下から入手できます。

https://www.merl.com/research/downloads/BRDF

RGL-EPFL Material Database の測定 BRDF（`.bsdf`）は以下から入手できます。
ファイル名末尾が `_rgb.bsdf` の RGB 版を使用してください（spectral 版は未対応）。

https://rgl.epfl.ch/materials

## ビュー

- `3D Plot`: BRDF の形状を 3D で確認します。
- `Polar Plot`: 角度方向の分布を極座標で確認します。
- `Theta V / Theta H / Theta D`: Cartesian plot で角度スライスを確認します。
- `Image Slice`: half/difference angle の断面を画像または高さ表示で確認します。
- `Lit Object`: HDRI 環境光で球・ティーポット・頭部モデル（`dm`）などを照らして確認します。
- `Lit Sphere`: 元 BRDF Explorer に近い球表示で確認します。

`ALBEDO` view は廃止しました。Monte Carlo 積分を含む巨大 shader が通常
`.brdf` の初回 compile を重くしていたため、現在の Cartesian plot は
`Theta V / Theta H / Theta D` のみです。

## 使い方

1. Web app を開きます。
2. `Open BRDF...` から `.brdf` / `.binary` / `.bsdf` ファイルを選びます。
3. サンプルを試す場合は `Load sample Brdf` を押して一覧から選びます。
4. 左側のパラメータで表示する BRDF を選び、値を調整します。

## 検証中の BRDF

以下の BRDF は検証中です。表示・比較には使えますが、仕様や参照実装と
数値的に完全一致しているとは限りません。結果が正しいとは限らないため、
比較・確認用として扱ってください。

| ファイル | 概要 |
|---|---|
| `sample/brdf/disney.brdf` | **独自実装**。Disney principled BRDF風のサンプルで、元ビューア実装そのものではありません。 |
| `sample/brdf/unreal_legacy_pbr.brdf` | **独自実装**。Unreal legacy Default Lit のローカルBRDF近似です。 |
| `sample/brdf/openpbr.brdf` | **独自実装**。OpenPBR風の不透明反射近似で、元の参照実装そのものではありません。 |
| `sample/brdf/substrate.brdf` | **独自実装**。Unreal Substrate Slab のローカルdirect lighting近似です。画面上の `second_roughness_as_clearcoat（custom）` は元実装にない独自拡張です。 |
| `sample/brdf/callisto_brdf.brdf` | **独自実装・近似**。The Callisto Protocol の Callisto BRDF（UE4 SubsurfaceProfile 拡張）を、出荷データとGPUキャプチャから再構成したローカルBRDFです。SSS・Dual Normal・Glazing Blur は含みません。詳細は [callisto_brdf reproduction status](docs/callisto_brdf_reproduction.md)。 |
| `sample/brdf/callisto_skin_jacob.brdf` ほか `callisto_skin_generic` / `callisto_eye` / `callisto_teeth` / `callisto_cloth_prisoner` | **派生プリセット**。`callisto_brdf.brdf` と同じシェーダで、初期値だけを素材ごとの出荷値にしたもの。`scripts/gen_callisto_presets.py` で生成（手で編集しない）。将来はビューアのプリセット機能に置き換える予定です。 |

アプリ内では `disney`、`unreal_legacy_pbr`、`openpbr`、`substrate`、`callisto_brdf`（派生プリセットを含む）の名前にも
`[custom implementation / 独自実装]` を付けて表示します。
読み込み後のBRDF見出しでは、名前とこの表記を2行に分けて表示します。

各項目が「そのまま実装」「代替」「省略」「独自」のどれかは
[PBR BRDF validation status](docs/pbr_brdf_validation_status.md) にまとめています。

## RGL-EPFL `.bsdf` の実装について

[rgl-epfl/brdf-loader](https://github.com/rgl-epfl/brdf-loader) の参照実装
（`powitacq_rgb`）の `eval()` を GLSL に移植したものです。

- `.bsdf`（tensor file 形式）をブラウザ内でパースし、ndf / sigma / vndf / rgb
  の各テーブルを単一の R32F テクスチャにパックして shader から参照します。
- vndf の逆写像（`Marginal2D::invert`）に必要な CDF テーブルは読み込み時に
  CPU 側で構築します。
- 参照実装の `eval()` は f_r に出射方向の cosine を掛けた値を返す規約のため、
  本ビューアの規約（素の f_r）に合わせて cosine で除算しています。
- 等方性・異方性データの両方に対応しています。spectral 版 `.bsdf` は未対応
  です（RGB 版 `_rgb.bsdf` を使用してください）。

## 開発

Windows ではリポジトリ直下の `run.bat` をダブルクリックするだけで、依存関係のインストール（初回・`package-lock.json` 更新時の `npm ci`）と開発サーバの起動まで行い、ブラウザが開きます。`run.bat pages` は本番ビルドを GitHub Pages と同じ `/brdf_view/` で表示します。

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

`npm run build` の前に `web/scripts/copy-assets.ts` が実行され、以下を
`web/public/` にコピーして manifest を作ります。

- `sample/brdf/*.brdf` -> `web/public/brdfs/index.json`
- `assets/*.hdr` / `assets/*.exr` -> `web/public/environments/index.json`
- `assets/*.hdr` -> `web/public/environment-thumbs/*.png`
- `assets/obj/*.obj` -> `web/public/obj/index.json`

`web/public/environments`、`web/public/environment-thumbs`、
`web/public/obj`、`web/dist` は生成物として
gitignore しています。HDRI を追加する場合は `assets/` に置いて commit し、
`npm run build` で `web/dist` に反映されることを確認してください。

GitHub Pages と同じ `/brdf_view/` prefix でローカル確認する場合:

```powershell
cd web
npm run build
cd ..
.\serve_pages_local.bat
```

`serve_pages_local.bat` は `web/dist` を `http://localhost:4173/brdf_view/`
で配信します。

## GitHub Pages

GitHub Pages は `.github/workflows/pages.yml` で `main` への push または
手動実行時に deploy されます。Action は `web` ディレクトリで以下を実行します。

```powershell
npm ci
npm run build
```

その後 `web/dist` を Pages artifact として upload します。追加した HDRI は
`assets/` に commit されていれば、Action の build 時に自動で
`environments/index.json` と `web/dist/environments/` に入ります。

## Attribution

This project is based on the Disney BRDF Explorer.

Original project:

https://github.com/wdas/brdf

Original Disney BRDF Explorer files carry Disney Enterprises copyright and
license notices. Redistributed files should keep the bundled license and
attribution files.
