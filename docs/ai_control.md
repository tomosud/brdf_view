# AI・スクリプトからの操作（URL / JS API / コマンドライン）

BRDF Explorer Web を、人の手を介さずに操作するための入口は 3 つある。どれも同じ「状態 JSON」（形式の版 `v=1`）を使う。

| 入口 | 使う場面 | GitHub Pages で使えるか |
| --- | --- | --- |
| 共有 URL（`#v=1&...`） | 状態を人や AI に渡す。開けば同じ表示になる | 使える |
| ページ内の JS API（`window.brdfView`） | ブラウザの中から状態を変える、画像・数値を取り出す | 使える |
| コマンドライン（`capture.bat` / `web/scripts/capture.mjs`） | 1 回のコマンドで PNG・数値データ・BRDF 評価値をファイルに保存する。図の作り直し | ローカルで実行する（中で Playwright と上の API を使う） |

## 1. 状態 JSON（v=1）

`window.brdfView.getState()` の出力、UI の「State JSON」欄、`--state` のファイルは、すべてこの形。角度はすべて度。

```json
{
  "v": 1,
  "brdfs": [
    { "file": "callisto_brdf.brdf", "visible": true, "params": { "roughness": 0.5, "base_color": [0.72, 0.53, 0.45] } },
    { "name": "my.brdf", "source": "<.brdf の全文>", "visible": false, "params": {} }
  ],
  "light": { "theta": 45, "phi": 45 },
  "plot": { "channel": "luminance", "logPlot": true, "nDotL": false },
  "plot3d":    { "camera": { "theta": 45, "phi": 0, "zoom": 4 } },
  "polar":     { "view": { "centerX": 0, "centerY": 0.75, "zoom": 1 } },
  "cartesian": { "mode": "thetaV", "phiV": 45, "lock": true, "fixedAngle": 0,
                 "view": { "centerX": 0.4, "centerY": 0.5, "zoom": 1, "scaleX": 0.8, "scaleY": 1 } },
  "slice":     { "mode": "image", "phiD": 90, "gamma": 2.2, "exposure": 0, "height": 0.065,
                 "squareThetaH": false, "showChroma": false, "surfaceZoom": 1 },
  "litObject": { "env": "ibl.hdr", "object": "sphere", "ibl": true, "samples": 128, "gamma": 2.2, "exposure": 0,
                 "hideBackground": false, "grayIBL": false, "camera": { "theta": 68.75, "phi": 34.38, "zoom": 1 } },
  "litSphere": { "brightness": 1, "gamma": 2.2, "exposure": 0, "doubleTheta": true, "nDotL": true }
}
```

| キー | 意味 |
| --- | --- |
| `brdfs[]` | 読み込む BRDF の並び。同梱サンプルは `file`（`sample/brdf/` のファイル名）。手元のファイルは `name` + `source`（全文）。MERL / RGL の測定データは状態に保存できない（`measured: true` が付くだけで、復元時は警告して飛ばす） |
| `brdfs[].visible` | 表示するか。プロット系は表示中のものをすべて重ねて描く。Image Slice・Lit Object・Lit Sphere は最初の表示中のものを使う。どれも `true` でなければ先頭を表示する |
| `brdfs[].params` | パラメータの値。`float` は数値、`bool` は `true/false`、`color` は `[r,g,b]`（シェーダに渡す生の値。UI の sRGB 欄と同じ数） |
| `light.theta / phi` | 入射光の角度（UI の Incident θ / φ）。θ は法線 +z から、φ は +x から |
| `plot` | `channel`（`red` / `green` / `blue` / `luminance`）、`logPlot`、`nDotL`（UI の「Multiply by N·L」） |
| `plot3d` ほか | 各ビューの下にある操作部品とカメラ |
| `litObject.ibl` | `true` = HDRI による IBL（従来の表示）。`false` = 入射光の角度からの平行光 1 つ（新しく UI にも「IBL」チェックを追加） |
| `litObject.samples` | IBL の 1 パスあたりのサンプル数（既定 128） |

`setState` の決まり:

- 書いたセクションだけを変える。書かないセクションはそのまま
- `brdfs` を書くと、読み込み済みの一覧をその並びで置き換える。同じファイルがすでに読み込まれていれば使い回す（シェーダを作り直さない）
- `brdfs[].params` に書かなかったパラメータは、その `.brdf` の既定値に戻る。1 つだけ変えたいときは `setParam` を使う
- 範囲外の値（`float` の min/max 外）も、そのまま渡す。UI のスライダーは範囲内しか表示しない
- 未知のキーは無視する。存在しないパラメータ名や不正な値は警告として返す（`{ warnings: [...] }`）
- `v` が 1 でなければ警告を出し、分かるキーだけ適用する

## 2. 共有 URL

アドレスバーの URL は操作に合わせて自動で書き換わる。UI の「Copy link」や `brdfView.getLink()` でも同じ URL が得られる。状態 JSON を平坦化して、ドット区切りのキーでハッシュに並べたもの。

```
https://tomosud.github.io/brdf_view/#v=1&brdfs.0.file=callisto_brdf.brdf&brdfs.0.visible=true&brdfs.0.params.roughness=0.4&brdfs.0.params.base_color=0.72,0.53,0.45&light.theta=60&light.phi=0&litObject.exposure=-1
```

- `v=1` が無いハッシュは状態として扱わない。`?v=1&...`（クエリ）でも読める
- 色や数値の 3 つ組は `r,g,b`。真偽値は `true` / `false`
- 手で短く書いてもよい。書かなかったキーは既定のまま（例: `#v=1&brdfs.0.file=lambert.brdf&light.theta=30`）
- 手元の `.brdf`（`source`）は `deflate:<base64url>` に圧縮して載せる
- URL に入るのは**表示中の BRDF だけ**。非表示で読み込んでいる BRDF は入らない
- アドレスバーは操作のたびに（約 0.4 秒ごとに確認して）書き換える。`history.replaceState` を使うので、履歴は増えず、再読み込みも状態の再適用も起きない
- 表示中の BRDF が外部のもの（自分で開いた `.brdf`、MERL / RGL の測定データ）のときは、アドレスバーを書き換えない。Copy link は使える（手元の `.brdf` は本文を圧縮して入れる。測定データは入らない）
- 画像（パラメータのテクスチャ、ノーマルマップ）は URL に入らない。状態 JSON の `brdfs[].textures` / `brdfs[].normalMap` に、ファイル名・チャンネル・色空間などが参考として出る（`setState` では復元しない）。画像はブラウザの IndexedDB に保存され、再読み込みで戻る（下記）
- アドレスバーに URL を打ち込む・貼り付けると、ページを読み直さずにその状態をすぐ適用する。書いたキーだけが変わり、そのあと URL は完全な形に書き直される
- 起動時は、URL に状態があれば IndexedDB の前回セッションより URL を優先する。アドレスバーは常に今の状態なので、再読み込みしても同じ表示に戻る。ただし非表示の BRDF は URL に入らないので、再読み込みで一覧から消える
- URL で開いたときも、前回のセッションで同じ BRDF（同じ同梱ファイル、または同じ `.brdf` の本文）に貼っていた画像は、IndexedDB から貼り直す。URL が無いときは、画像を含めて前回のセッションをそのまま戻す
- IndexedDB には、画像のファイルを別のストア（`blobs`）に 1 枚 1 回だけ保存し、使われなくなった画像は消す（データベースの版は 2。版 1 の既存データはそのまま読める）

## 3. JS API（`window.brdfView`）

ブラウザの開発者ツールや Playwright の `page.evaluate` から使う。非同期のものは Promise を返す。

| 関数 | 返り値・説明 |
| --- | --- |
| `ready` | 初期化完了（ビュー生成、シェーダ雛形の読み込み、URL / 前回セッションの適用）で解決する Promise |
| `getState()` | 状態 JSON（全パラメータを含む） |
| `setState(state)` | 状態 JSON、または共有 URL・`v=1&...` の文字列を適用。`{ warnings }` を返す。BRDF・環境・モデルの読み込み完了まで待つ |
| `getLink()` | 今の状態の共有 URL（今開いているページの URL を基にする） |
| `listBrdfs()` | `{ available: [同梱ファイル名], loaded: [{ index, name, file, kind, visible, active }] }` |
| `listParams(brdf?)` | `[{ name, kind, min?, max?, default, value, description }]`。`description` は `.brdf` のコメント |
| `setParam(name, value, brdf?)` | パラメータを 1 つ変える。色は `[r,g,b]` か `"r,g,b"` |
| `setTexture(name, src, { brdf, fileName, channel, colorSpace })` | float / color のパラメータに画像を貼る（Lit Object のみ、メッシュの UV で貼る）。`src` は URL か data URL、`null` で外す。`channel` は float 用で `r` / `g` / `b` / `a`（既定 `r`。color は常に RGB）。`colorSpace` は画像の色空間 `srgb` / `linear`（既定: base color は `srgb`、それ以外は `linear`）。値は `.brdf` が期待する形に直す（color は sRGB の値、float はリニアの値）。状態や URL には入らない |
| `setNormalMap(src, { brdf, fileName, flipY, strength })` | BRDF にタンジェント空間のノーマルマップを貼る（Lit Object のみ。既定は DirectX 形式 `flipY: true`、OpenGL 形式なら `flipY: false`。`strength` は XY の倍率、既定 1）。`null` で外す |
| `listViews()` | `{ views, dataViews, environments, objects }` |
| `render(view, { width, height, frames, supersample, background })` | PNG の data URL（表示用の画像。露出・ガンマ込み）。指定サイズで 1 回だけ描く（DPR・ウィンドウの大きさに依存しない。UI は写らない）。`litObject` の IBL は `frames` 回（既定 512 = 画面で収束する回数）積算してから返す。`supersample: n`（1〜8、既定 1）で n 倍の大きさに描いてリニアで縮小する（アンチエイリアス）。`background` は `'view'`（既定、ビュー本来の背景）、`'transparent'`（アルファ付き）、sRGB の `[r, g, b]`（`litObject` / `litSphere` のみ） |
| `evaluate(input, { brdf, params })` | BRDF の生の値（RGB）。`input` は `{ L, V, N?, X?, Y? }`（ベクトル）か `{ thetaL, phiL, thetaV, phiV }`（度。N/X/Y 基準）。配列を渡すと配列で返す。`params` は一時的な上書きで、状態は変えない |
| `exportData(view, { format, resolution })` | プロットやスライスの数値。`format: 'csv'` で CSV 文字列、既定は JSON オブジェクト |
| `errors()` | シェーダのコンパイル・リンクのエラー |

`brdf` 引数は、`state.brdfs` の添字、同梱ファイル名、表示名のどれか。省略すると最初の表示中の BRDF。

ビュー名: `plot3d`（別名 `3d`）、`polar`、`cartesian`、`slice`（`image`）、`litObject`（`lit`）、`litSphere`（`sphere`）。

### evaluate の約束

- 表示用と同じ `.brdf` の GLSL を、専用のオフスクリーン WebGL2 で評価する（float32、RGBA32F で読み戻し）
- 値は `BRDF(L, V, N, X, Y)` の返り値そのもの。0 未満の切り捨て、N·L、露出、log は掛けない
- 既定の局所座標は `N = (0,0,1)`、`X = (1,0,0)`、`Y = (0,1,0)`。ベクトルは正規化してから渡す

```js
await brdfView.evaluate({ thetaL: 60, phiL: 0, thetaV: 30, phiV: 180 });            // [r, g, b]
await brdfView.evaluate([{ L: [0.5, 0, 0.866], V: [-0.5, 0, 0.866] }], { params: { roughness: 0.3 } });
```

### exportData の列

| view | 先頭の列 | 既定の分割数（`resolution`） | 幾何 |
| --- | --- | --- | --- |
| `slice` | `thetaH_deg, thetaD_deg` | 91（0〜90° を 1° 刻み） | Image Slice と同じ（φH = 入射 φ、φD = スライスの phiD）。最初の表示中の BRDF だけ |
| `polar` | `thetaV_deg` | 361（−90〜90°） | 入射光の方位面で V を振る。負の側が光と反対側（鏡面反射の側） |
| `cartesian` | `thetaV_deg` / `thetaH_deg` / `thetaD_deg` | 513（−90〜90°） | 今のモード。固定角は `meta` |
| `plot3d` | `thetaV_deg, phiV_deg` | θV 19 点 × φV 73 点（5° 刻み） | 入射光は固定 |

続く列は共通で `Lx, Ly, Lz, Vx, Vy, Vz, r, g, b`。プロット系（`polar` / `cartesian` / `plot3d`）は、さらに `value`（チャンネルの重みを掛け、`plot.nDotL` なら N·L を掛け、0 以上に切った値）と `plotted`（Log plot が有効なら `log10(value + 1)`）が付く。

JSON は `{ view, columns, meta, series: [{ brdf, name, rows }] }`。CSV は先頭に `brdf`（`state.brdfs` の添字）の列が付く。表示中の BRDF が複数あれば、その数だけ系列が並ぶ。

Lit Object と Lit Sphere は画像なので `render` を使う。

## 4. コマンドライン

Windows ではリポジトリ直下の `capture.bat`、ほかでは `node web/scripts/capture.mjs`。初回は `npm ci` を実行する（`capture.bat` は自動）。ブラウザが無いと言われたら `cd web && npx playwright install chromium`。

既定では Vite を同じプロセス内で起動するので、ビルドは不要で、`sample/brdf/` の編集もすぐ反映される。`--dist` はビルド済みの `web/dist` を `/brdf_view/` で配る。`--base <url>` は起動中のサーバ（`npm run dev` など）を使う。

```bat
rem 状態ファイルから Lit Object の PNG
capture.bat --state state.json --view litObject --out out.png

rem 共有 URL から、スライスの PNG と数値（CSV）を 1 回で
capture.bat --url "https://tomosud.github.io/brdf_view/#v=1&brdfs.0.file=callisto_brdf.brdf" --view slice --out slice.png --data slice.csv

rem BRDF とパラメータと光をその場で指定して、複数のビューを撮る（{view} がビュー名に置き換わる）
capture.bat --brdf callisto_skin_jacob.brdf --set roughness=0.4 --set base_color=0.8,0.6,0.5 --light 60,0 --view litObject,litSphere,polar --out figs/jacob_{view}.png

rem 任意のキーは --opt（URL と同じ書き方）
capture.bat --brdf callisto_brdf.brdf --opt litObject.object=dm.obj --opt litObject.ibl=false --opt plot.nDotL=true --view litObject --out head.png

rem BRDF の数値評価（結果は JSON）
capture.bat --brdf callisto_brdf.brdf --eval samples.json --eval-out values.json

rem 解決後の状態と共有 URL を残す
capture.bat --brdf callisto_brdf.brdf --set roughness=0.3 --save-state state.json --print-link
```

主なオプション（`--help` で全部）:

| オプション | 内容 |
| --- | --- |
| `--url` / `--state` / `--brdf` / `--set` / `--light` / `--opt` | 状態の指定。この順に適用する |
| `--texture 名前[:チャンネル][:色空間]=画像` | パラメータに画像を貼る（Lit Object、複数可）。例 `base_color=albedo.png`、`roughness:g=orm.png`、`roughness:r:srgb=rough.png`。バッチでは `"texture": { "base_color": "albedo.png", "roughness": { "file": "orm.png", "channel": "g" } }` |
| `--normal-map` / `--normal-gl` / `--normal-strength` | ノーマルマップ（Lit Object）。既定は DirectX 形式、`--normal-gl` で OpenGL 形式。バッチでは `normalMap` / `normalFlipY`（既定 true）/ `normalStrength` |
| `--view` / `--out` | 撮るビュー（複数可、`page` は画面全体）と PNG の保存先 |
| `--width` / `--height` | 画像のサイズ（既定 512×512。`page` はウィンドウの大きさ、既定 1600×1000） |
| `--frames` | `litObject` の IBL の積算回数（既定 512） |
| `--supersample <n>` | アンチエイリアス。n 倍で描いて縮小（1〜8、既定 1） |
| `--background <bg>` | `view`（既定）/ `transparent` / `r,g,b`（sRGB 0〜1）。`litObject` / `litSphere` のみ |
| `--figure` | 文書用の見本画像のプリセット。`--supersample 4`、`litObject` / `litSphere` は背景を透過（明示した値が優先） |
| `--data` / `--data-view` / `--resolution` | `exportData` の保存先（`.csv` なら CSV、ほかは JSON）、対象ビュー、分割数 |
| `--eval` / `--eval-out` | 評価する点の JSON（配列、または `{ "samples": [...], "brdf": ..., "params": {...} }`）と結果の保存先（省略時は標準出力） |
| `--save-state` / `--print-link` | 状態 JSON の保存、共有 URL の出力 |
| `--batch` | 複数のジョブを 1 つのブラウザで実行（下記） |

### バッチ

図をまとめて作り直すときに使う。パスはバッチファイルからの相対。ジョブごとに新しいページを開くので、前のジョブの状態は残らない。

```json
{
  "defaults": { "brdf": "callisto_skin_jacob.brdf", "width": 768, "height": 768,
                "opt": { "litObject.object": "dm.obj", "litObject.ibl": false, "plot.nDotL": true,
                         "litObject.camera.theta": 90, "litObject.camera.phi": 90, "litObject.hideBackground": true } },
  "jobs": [
    { "light": "0,0",   "view": "litObject", "out": "figures/brdf_head_l000.png" },
    { "light": "90,0",  "view": "litObject", "out": "figures/brdf_head_l090.png" },
    { "light": "130,0", "view": "litObject", "out": "figures/brdf_head_l130.png" },
    { "view": "slice", "out": "figures/brdf_slice.png", "data": "figures/brdf_slice.csv" }
  ]
}
```

`set` と `opt` は、配列（`["roughness=0.4"]`）でもオブジェクト（`{ "roughness": 0.4 }`）でもよい。`state` はファイル名でも JSON オブジェクトでもよい。

## 5. 再現性と座標の注意

- 同じ状態・同じサイズなら同じ画像になる（`render` は DPR に依存せず、アニメーションも無い）。IBL は `frames` 回の積算で止める。乱数列はフレーム番号と画素位置だけで決まる。ただし GPU やドライバが違えば、最下位ビットの差は出うる。コマンドラインは使った GPU を `WebGL renderer:` として表示する
- Lit Object の世界座標は y が上。入射光ベクトルは他のビューと同じ式 `(sinθ cosφ, sinθ sinφ, cosθ)` のまま使う。`litObject.camera = { theta: 90, phi: 90 }`（+z から正面を見る）にすると、光の θ は「カメラ方向からの角度」、φ は「画面右（0°）から上（90°）への回転」になる。頭部モデル `dm.obj` もこの向きで正面を向く
- 平行光（`litObject.ibl = false`）の N·L は、全体の `plot.nDotL`（Multiply by N·L）に従う。照らされた見た目にしたいときは `plot.nDotL = true`
- Lit Sphere は `doubleTheta`（既定オン）で光の θ を 2 倍にして描く。θ = 60° なら 120° から照らす
- Incident θ のスライダーは 0〜90°だが、状態や API では 90° を超える値（後ろからの光）も渡せる

## 6. 操作部品の識別子（data-testid）

UI を直接操作するとき（Playwright のロケータなど）に使う。

| 識別子 | 場所 |
| --- | --- |
| `open-brdf`, `file-input`, `load-sample`, `sample-select` | ツールバー |
| `copy-link`, `state-json-toggle` | ツールバー（リンクのコピー、状態 JSON 欄の開閉） |
| `state-panel`, `state-json`, `state-refresh`, `state-apply`, `state-download`, `state-status` | 状態 JSON 欄 |
| `parameter-panel`, `plot-controls` | 左のパネル、Plot 節 |
| `brdf-<添字>`（`data-brdf-file`, `data-visible` 付き）、`brdf-visible`, `brdf-defaults`, `brdf-close` | BRDF ごとの節 |
| `param-<パラメータ名>` | パラメータの行 |
| `view-<ビュー名>`, `canvas-<ビュー名>`, `controls-<ビュー名>` | 各ビュー |
| `ctl-<ラベル>` | 操作部品の行。ラベルを小文字・ハイフンにしたもの（例 `ctl-incident-theta`, `ctl-exposure`, `ctl-ibl`）。ビューや節で絞り込んで使う |

数値の行は `input[data-role=value]`（数値欄）と `input[data-role=slider]` を持つ。入力欄には `aria-label` が付いている。

例: `[data-testid=view-litObject] [data-testid=ctl-exposure] input[data-role=value]`

## 7. 互換性

- 既存の `.brdf` の読み方は変えていない。評価用のシェーダ雛形 `evaluate.frag` も、表示用と同じ差し込み（`::INSERT_UNIFORMS_HERE::` など）を使う
- 状態の形式を互換性の無い形で変えるときは `v` を上げ、古い `v=1` の読み込みを残す
- GitHub Pages では URL と JS API が動く。コマンドラインはローカル専用（静的サイトにはサーバ機能を足していない）

## 検証用の数値と文書用の画像の区別

| 目的 | 経路 | 値 |
| --- | --- | --- |
| 検証（数値の比較） | `evaluate`（`--eval`）、`exportData`（`--data`） | `.brdf` の `BRDF()` の生の RGB（float32、リニア）。露出・トーンマップ・ガンマ・クランプは掛からない。`exportData` の `value` / `plotted` だけはプロットと同じチャンネル・N·L・log を含む |
| 文書の見本画像 | `render`（`--view ... --out`）。図には `--figure` | 表示と同じ画像（露出・ガンマ込み、8bit sRGB PNG）。数値の比較には使わない |
