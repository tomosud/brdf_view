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

ツールバーの `Tone map (ACES 2.0)`（既定オフ）をオンにすると、`Lit Object`・`Lit Sphere`・`Image Slice` の表示に ACES 2.0 の Output Transform（SDR 100 nits、Rec.709、sRGB の符号化）をかけます。明るいところが白く飛ばずになだらかに丸まり、彩度の高い色も表示範囲に収めます。描画結果はリニアの Rec.709 として ACES に渡します。`Exposure` はトーンマップの前にかかり、オンの間は `Gamma` を使いません（灰色で無効になります）。OpenColorIO の ACES studio config（「sRGB - Display」/「ACES 2.0 - SDR 100 nits (Rec.709)」、入力「Linear Rec.709 (sRGB)」）と、8 bit で 1/255 未満の差で一致することを確かめています。オフのときの表示は今までと同じです。

ツールバーの `HDR`（既定オフ）をオンにすると、同じ 3 つのビューを HDR で表示します（Chrome 系のブラウザ、Windows の「HDR を使用する」がオンの HDR モニター）。画面の 1.0 を SDR の白（203 nits、ITU-R BT.2408）として、それより明るい値をそのまま出します。`Tone map` もオンなら ACES 2.0 の HDR 版（1000 nits、P3-D65。OpenColorIO の「Display P3 HDR - Display」/「ACES 2.0 - HDR 1000 nits (P3 D65)」と同じ計算で、1.0 を 203 nits に合わせたもの）、オフなら今の表示から 1 での切り捨てを外しただけのものになります。HDR 表示でないモニターに移すと自動で SDR に戻ります。撮影（PNG、`render()`、`capture.bat`）は常に SDR です。

`ALBEDO` view は廃止しました。Monte Carlo 積分を含む巨大 shader が通常
`.brdf` の初回 compile を重くしていたため、現在の Cartesian plot は
`Theta V / Theta H / Theta D` のみです。

## 使い方

1. Web app を開きます。
2. `Open BRDF...` から `.brdf` / `.binary` / `.bsdf` ファイルを選びます。
3. サンプルを試す場合は `Load sample Brdf` を押して一覧から選びます。
4. 左側のパラメータで表示する BRDF を選び、値を調整します。

## 状態の共有と自動操作（URL / JS API / コマンドライン）

表示の状態（読み込んだ `.brdf`、全パラメータ、ライトの角度、各ビューの露出・モード・カメラ・環境・モデル）を、1 つの JSON（形式の版 `v=1`）で扱えます。詳しくは [AI・スクリプトからの操作](docs/ai_control.md)。

- **共有 URL**: アドレスバーの URL が操作に合わせて自動で更新されます（表示中の BRDF だけが入ります。外部の `.brdf` や測定データを表示中は更新しません）。URL を打ち込むと、すぐその状態になります。ツールバーの `Copy link` でも、今の状態を再現する URL をコピーできます（例 `https://tomosud.github.io/brdf_view/#v=1&brdfs.0.file=callisto_brdf.brdf&light.theta=60`）。開くと同じ BRDF・パラメータ・ライトで表示されます。未知のキーは無視します。
- **State JSON**: ツールバーの `State JSON` で、状態を JSON で表示・貼り付け（`Apply`）・保存（`Download`）できます。共有 URL を貼っても適用できます。
- **JS API**: ページ内の `window.brdfView` から、`getState()` / `setState()` / `listBrdfs()` / `listParams()` / `setParam()`、`render(view, {width, height, supersample, background})`（PNG。表示用の画像）、`evaluate({L, V, ...})`（BRDF の生の RGB 値。露出・ガンマ前のリニア float）、`exportData(view)`（プロットやスライスの数値、JSON / CSV）を呼べます。GitHub Pages 版でも動きます。
- **コマンドライン**: `capture.bat`（または `node web/scripts/capture.mjs`）で、ヘッドレスブラウザ（Playwright）から PNG・数値データ・評価値を 1 回で保存します。

```bat
capture.bat --brdf callisto_brdf.brdf --set roughness=0.4 --light 60,0 --view litObject,slice --out out_{view}.png --data slice.csv
capture.bat --url "<共有 URL>" --view litObject --out out.png
capture.bat --state fig.json --view litObject --figure --width 768 --height 768 --out fig.png
capture.bat --batch jobs.json
```

- 操作部品には `data-testid`（例 `param-roughness`、`view-litObject`、`ctl-exposure`）と `aria-label` を付けています。
- Lit Object に `IBL` のチェックを追加しました。外すと HDRI の代わりに、Incident θ/φ からの平行光 1 つで照らします。
- Lit Object の `Occlusion` は、モデル自身による環境光の遮蔽を IBL に反映します（鼻の穴、眼窩、耳の内側、顎の下など）。`Off` / `SH` / `Ray` から選びます（既定 `SH`）。どれも遮る光を減らすだけで相互反射は含まず、平行光（IBL オフ）には効きません。凸形状（球）の見た目はどれでも変わりません。
  - `SH`: モデルの読み込み時に、頂点ごとに方向別の遮蔽を球面調和関数（l ≤ 3、16 係数）として GPU で事前計算します。軽いですが低次の近似なので、くっきりした影は出ません。
  - `Ray`: サンプルごとにモデルへ影のレイを飛ばして正確に判定します（初めて選んだときに、BVH をバックグラウンドで作ります。25 万頂点で約 1 秒）。接するところの影もくっきり出ますが重く、GPU のタイムアウトを避けるため 1 フレームのサンプル数を減らして描くので、収束まで数十秒かかります。カメラを動かしている間は `SH` で描き、離すと `Ray` で積算し直します。モデルは閉じていて法線が外を向いている前提で、レイが裏側から当たる面は遮蔽として数えません。
- AI エージェント用の手順は [.claude/skills/brdf-view/SKILL.md](.claude/skills/brdf-view/SKILL.md) にあります。

## テクスチャとノーマルマップ

左のパネルで、BRDF の行に画像ファイル（PNG / JPEG / WebP）をドロップすると、Lit Object のモデルに UV で貼られます。

- **パラメータ**（例 `base_color`、`roughness`）: そのパラメータが画素ごとに画像の値になります。
  - float のパラメータでは、ドロップしたときに使うチャンネル（R / G / B / A）を選びます（キーボードの R/G/B/A でも可、Esc で中止）。ORM などのまとめた画像から 1 チャンネルずつ割り当てられます。color のパラメータは RGB を使います。
  - 画像の色空間は、`base_color`（名前に base color / albedo を含むもの）が sRGB、それ以外はリニアが既定です。行の下の見本で、チャンネルと色空間（sRGB / Linear）をあとから変えられます。
  - 値は `.brdf` が期待する形に直して渡します。color のパラメータは色の選択欄と同じ sRGB の値（`.brdf` 側で `mon2lin` してリニアにする）、float のパラメータはリニアの値です。sRGB の `base_color` 画像はそのまま渡すので、二重に変換されません。
- **ノーマルマップ**: どの BRDF にも、先頭に `normal map` の行があります。タンジェント空間のノーマルマップをドロップします。既定は DirectX 形式（`DX` がオン、緑チャンネルを反転）で、OpenGL 形式の画像なら `DX` を外します。数値で強さを変えられます。ノーマルマップは常にリニアとして扱います。
- 見本の `×` で外せます。
- 効くのは Lit Object だけです。プロット・スライス・Lit Sphere は、これまでどおりスライダーの値と幾何の法線を使います。
- UV を持つモデル（`dm`、`teapot`、`myaku`、内蔵の `sphere`）で使えます。タンジェントは UV から計算します。
- 貼った画像は、ブラウザの IndexedDB に保存され、再読み込みしても残ります（チャンネル・色空間・DX・強さも含む）。URL 付きで開いたときも、同じ BRDF（同じファイル）に保存してある画像を貼り直します。
- 画像は共有 URL や状態 JSON には入りません（状態 JSON には、ファイル名・チャンネル・色空間などが参考として出ます）。別の PC やブラウザにリンクを渡しても、画像は付きません。
- スクリプトからは `brdfView.setTexture('roughness', url, { channel: 'g' })`・`brdfView.setNormalMap(url)`、コマンドラインからは `--texture roughness:g=orm.png`・`--normal-map normal.png`。

## パラメータのコメント（ツールチップ）

`.brdf` のパラメータ行の末尾に `# 日本語 / English` の形でコメントを書くと、画面のパラメータ名にマウスを乗せたときにツールチップとして表示されます（このプロジェクトの拡張。元の形式ではコメントは無視されるだけなので互換性は保たれます）。

```text
float roughness 0.02 1.0 0.5  # ラフネス（下限 0.02） / roughness (clamped to >= 0.02)
```

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
| `sample/brdf/brdf_slice_guide.brdf` | **独自の説明用（物理的な BRDF ではない）**。Image Slice（横 θh・縦 θd）のどの領域が何を表すかを色分けで示します。白 = スペキュラのピーク（左端）、マゼンタ = グレージングのフレネル（左上）、赤 = 再帰反射（右下）、黄 = カメラと同じ方向からの照明（下端、L ≒ V）、青 = 光が地平線付近（N·L→0）、シアン = 視線が地平線付近（N·V→0）、暗赤 = 地平線より下（本来は 0）。領域ごとに `show_*`（表示の切り替え）と `*_color`（色見本＝凡例。変えても Defaults で戻る）を持ちます。 |
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

ヘッドレスでの撮影（`capture.bat`）も、初回に同じく `npm ci` を実行します。Playwright の Chromium が無い環境では、`web` で `npx playwright install chromium` を一度実行してください。

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

The ACES 2.0 tone mapping (`web/src/gl/aces2.ts`, `web/src/gl/tonemap.ts`) is a
port of the ACES Output Transform from
[aces-aswf/aces-core](https://github.com/aces-aswf/aces-core)
(Copyright Contributors to the ACES Project, Apache-2.0). See
`web/public/licenses/ACES-LICENSE.txt`.
