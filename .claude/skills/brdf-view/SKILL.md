---
name: brdf-view
description: BRDF Explorer Web（tomosud/brdf_view）を URL・ページ内 JS API（window.brdfView）・コマンドライン（capture.bat / web/scripts/capture.mjs）で操作し、.brdf の表示を PNG に撮る、BRDF の値を数値で評価する、プロットやスライスの数値を CSV/JSON で取り出す、状態を共有 URL にする。Use when asked to render, screenshot, compare, verify or export data from brdf_view / a .brdf file (lit sphere, lit object / head model, image slice, polar / cartesian plots).
---

# brdf_view を操作する

BRDF Explorer Web の状態は 1 つの JSON（`v: 1`）で表せる。URL・JS API・コマンドラインはどれもこの JSON を使う。詳しい仕様はリポジトリの `docs/ai_control.md`。

## どれを使うか

| やりたいこと | 方法 |
| --- | --- |
| 画像や数値をファイルに残す（図の作成、検証） | コマンドライン `capture.bat`（Windows、リポジトリ直下）/ `node web/scripts/capture.mjs` |
| 状態を人に渡す、ブラウザで開いて見せる | 共有 URL `https://tomosud.github.io/brdf_view/#v=1&...`（ローカルは `http://localhost:5173/#v=1&...`） |
| ブラウザの中で対話的に調べる | `window.brdfView`（開発者ツール、Playwright の `page.evaluate`、ブラウザ操作ツールの JS 実行） |

UI をクリックで操作するより、上のどれかを使う。UI を触る必要があるときは `data-testid`（`param-<名前>`、`view-<ビュー>`、`ctl-<ラベル>`、`copy-link`、`state-json` など）で要素を探す。

## 手順

1. 使える BRDF とパラメータを調べる
   - BRDF は `sample/brdf/*.brdf`。パラメータは各ファイルの `::begin parameters` の行（`float 名前 最小 最大 既定  # 説明`、`bool 名前 既定`、`color 名前 r g b`）
   - ページ内なら `await brdfView.listBrdfs()`、`brdfView.listParams()`
2. 状態を決める。最小限でよい（書かないキーは既定値）
   ```json
   { "v": 1,
     "brdfs": [{ "file": "callisto_brdf.brdf", "params": { "roughness": 0.4, "base_color": [0.72, 0.53, 0.45] } }],
     "light": { "theta": 60, "phi": 0 },
     "litObject": { "object": "dm.obj", "ibl": false, "camera": { "theta": 90, "phi": 90 }, "hideBackground": true },
     "plot": { "nDotL": true } }
   ```
3. 撮る・取り出す
   ```bat
   capture.bat --state state.json --view litObject,slice,polar --out out/{view}.png --data out/slice.csv --data-view slice
   capture.bat --brdf callisto_brdf.brdf --set roughness=0.4 --light 60,0 --view litSphere --out sphere.png
   capture.bat --brdf callisto_brdf.brdf --eval samples.json --eval-out values.json
   capture.bat --batch jobs.json
   ```
   - `--state` / `--url` / `--brdf` / `--set name=value` / `--light θ,φ` / `--opt key=value`（URL と同じキー、例 `litObject.exposure=-1`）の順に適用される
   - ビュー名: `litObject`（`lit`）、`litSphere`（`sphere`）、`slice`、`polar`、`cartesian`、`plot3d`、`page`（画面全体）
   - 既定サイズ 512×512、`--width` / `--height` で変える。IBL は `--frames`（既定 512）回積算
   - 文書の図は `--figure`（4 倍のスーパーサンプリング、`litObject` / `litSphere` は背景透過）。個別には `--supersample n`、`--background transparent|r,g,b`
   - 検証の数値は画像から取らない。`--eval`（`evaluate`）/ `--data`（`exportData`）は露出・ガンマ前のリニア float
   - 図をまとめて作るときは `--batch`（`{"defaults": {...}, "jobs": [...]}`、パスはバッチファイルから相対）
4. 結果を確かめる
   - 出力 PNG を開いて目で確認する
   - `shader error:` や `warning:` が出ていないか見る（存在しないパラメータ名は警告になる）
   - 再現用に `--save-state state.json` と `--print-link` を残す

## ページ内 API（要点）

```js
await brdfView.ready;
await brdfView.setState({ brdfs: [{ file: 'callisto_skin_jacob.brdf' }], light: { theta: 90, phi: 0 } });
brdfView.setParam('roughness', 0.3);
const png = await brdfView.render('litObject', { width: 768, height: 768 });   // data:image/png;base64,...
const rgb = await brdfView.evaluate({ thetaL: 60, phiL: 0, thetaV: 30, phiV: 180 }); // [r, g, b]
const csv = await brdfView.exportData('polar', { format: 'csv' });
const link = await brdfView.getLink();
```

- `evaluate` は `.brdf` の `BRDF(L, V, N, X, Y)` の生の値（切り捨て・N·L・露出なし）。既定の局所座標は N=(0,0,1)、X=(1,0,0)、Y=(0,1,0)。`{ params: {...} }` で一時的に値を変えて評価できる
- `exportData` の列: 角度、`Lx..Vz`、`r,g,b`、プロット系はさらに `value`（チャンネル・N·L 込み）と `plotted`（log 込み）

## 注意

- 角度はすべて度。光の θ は法線 +z から、φ は +x から
- 頭部や球を正面から平行光で照らすとき: `litObject.ibl=false`、`litObject.camera={theta:90, phi:90}`、`plot.nDotL=true`。光の θ がカメラ方向からの角度になる（0° = 正面、90° = 真横、130° = 斜め後ろ）
- Lit Sphere は `doubleTheta`（既定オン）で光の θ を 2 倍にする
- `brdfs` を書くと BRDF の一覧を置き換え、書かなかったパラメータは `.brdf` の既定値に戻る
- `sample/brdf/` を編集した直後でも、コマンドラインは既定で Vite をその場で起動するので反映される（`--dist` はビルド済みを使う）
- 初回は `web` で `npm ci`（`capture.bat` は自動）。Chromium が無ければ `npx playwright install chromium`
- `.brdf` を手で編集するときは、リポジトリの CLAUDE.md の決まり（パラメータのコメントは日本語 / 英語、近似や独自拡張はその旨を明記）に従う。`callisto_*` の派生プリセットは `scripts/gen_callisto_presets.py` で生成し、手で編集しない
