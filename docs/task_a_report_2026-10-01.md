# タスク A 報告: brdf_view を AI から操作しやすくする（2026-10-01）

`skin_mat_lean/docs/HANDOFF.md` の「3.1 タスク A」の実装報告。**コミットはしていない。** 使い方の詳細は [ai_control.md](ai_control.md)。

## 1. 結果（受け入れ条件）

| 受け入れ条件 | 結果 | 確かめた方法 |
| --- | --- | --- |
| 共有 URL を開くと、同じ `.brdf`・同じパラメータ・同じライトで表示される | 満たす | `getLink()` の URL を新しいページで開き、`getState()` が元と完全一致。同じ状態の PNG（IBL を含む）もバイト単位で一致 |
| コマンド 1 回で、指定した状態の PNG と数値データが取れる | 満たす | `capture.bat --state s.json --view slice --out s.png --data s.csv` など |
| 既存の `.brdf` がそのまま読める | 満たす | 同梱 53 本を全ビューで描画し、`evaluate` も実行。52 本は成功。`dAniso.brdf` だけは変更前から失敗している（下の 5 章） |
| GitHub Pages のビルドが通る | 満たす | `npm ci` → `npm run build`（Pages と同じ手順）が通る。`dist` は `/brdf_view/` で配られる。`--dist` でビルド済みからも撮影できた |
| 使い方が README とスキルに書いてある | 満たす | README に節を追加、`docs/ai_control.md`、`.claude/skills/brdf-view/SKILL.md` |

## 2. 作ったもの

1. **状態 JSON（`v: 1`）** — BRDF の並び（同梱は `file`、手元のファイルは `source`）、全パラメータ、ライトの角度（度）、チャンネル・Log・N·L、6 つのビューの操作部品とカメラ（Lit Object の環境・モデル・IBL を含む）
2. **共有 URL** — 状態を `#v=1&brdfs.0.file=...&light.theta=60` の形で平坦化する。人が読めて、手で書ける。未知のキーは無視する。手元の `.brdf` は deflate で圧縮して載せる。URL に状態があれば、IndexedDB の前回セッションより優先する
3. **UI** — ツールバーに `Copy link` と `State JSON`（表示・貼り付けて Apply・Download）。Lit Object に `IBL` のチェックを追加した（外すと Incident θ/φ からの平行光。図の「光 0°/90°/130°」に使える）
4. **`window.brdfView`** — `ready`、`getState` / `setState`、`getLink`、`listBrdfs`、`listParams`、`setParam`、`listViews`、`render(view, {width, height, frames})`、`evaluate(input, {brdf, params})`、`exportData(view, {format, resolution})`、`errors()`
   - `render` は指定サイズで 1 回だけ描く（DPR に依存しない）。IBL は決まった回数（既定 512）だけ積算する
   - `evaluate` は専用のオフスクリーン WebGL2 で `.brdf` の GLSL をそのまま評価し、RGBA32F で読み戻す。Lambert（0.7/π）と GGX の D を閉じた式と比べ、float の精度（相対 1e-6）で一致した
   - `exportData` は各ビューのシェーダと同じ幾何で L・V を作り、`evaluate` で値を出す（slice / polar / cartesian / plot3d）
5. **コマンドライン** — `capture.bat`（リポジトリ直下）/ `web/scripts/capture.mjs`。Playwright の Chromium を使う。既定では Vite を同じプロセスで起動するのでビルド不要（`sample/brdf/` の編集がすぐ反映される）。`--dist`、`--base <url>` も可。`--batch` で複数の図を 1 つのブラウザで作れる
6. **識別子** — ビュー、パラメータ行、操作部品、ツールバーに `data-testid` と `aria-label`
7. **スキル** — `.claude/skills/brdf-view/SKILL.md`（このリポジトリで Claude Code を開くと使える）

HTTP API（`/render`、`/data`）は作っていない。コマンドラインとバッチで足りると判断した。

## 3. 変更したファイル

| ファイル | 内容 |
| --- | --- |
| `web/src/api/state.ts`（新規） | 状態 JSON の収集・適用、URL との変換 |
| `web/src/api/index.ts`（新規） | `window.brdfView` |
| `web/src/api/evaluate.ts`（新規） | GPU による BRDF の数値評価 |
| `web/src/api/export-data.ts`（新規） | `exportData` |
| `web/public/shaderTemplates/evaluate.frag` / `.vert`（新規） | 評価用のシェーダ雛形（表示用と同じ差し込み方） |
| `web/src/ui/state-tools.ts`（新規） | Copy link と State JSON 欄 |
| `web/scripts/capture.mjs`（新規）、`capture.bat`（新規） | コマンドライン |
| `web/src/views/base-view.ts` | ビューの識別子、固定サイズでの撮影、ビューの状態の読み書きの共通部分 |
| `web/src/views/*.ts`（6 本） | 各ビューの状態の読み書き。Lit Object は IBL の切り替え、読み込み待ち、決まった回数の積算 |
| `web/src/app.ts` | API の設置、URL の状態を優先して適用 |
| `web/src/state/store.ts` | `setBrdfs`（BRDF の並びの置き換え） |
| `web/src/gl/brdf-program.ts` | シェーダのエラーを `errors()` 用に記録 |
| `web/src/ui/controls.ts`、`parameter-panel.ts`、`web/index.html`、`web/src/style.css` | `data-testid`・`aria-label`、新しい欄の見た目 |
| `web/package.json`、`package-lock.json` | devDependencies に `playwright@1.62.0` を追加（この PC にある Chromium 1234 と合う版） |
| `README.md`、`CLAUDE.md`、`docs/ai_control.md`（新規）、`.claude/skills/brdf-view/SKILL.md`（新規） | 使い方と開発の決まり |

`.brdf` のパーサ、シェーダの組み立て（`shader-builder.ts`）、表示用のシェーダ雛形、`sample/brdf/` は変えていない。

## 4. 使い方（短く）

```bat
rem 状態を決めて撮る（PNG と数値を 1 回で）
capture.bat --brdf callisto_brdf.brdf --set roughness=0.4 --light 60,0 --view litObject,slice --out out_{view}.png --data slice.csv

rem 共有 URL から撮る
capture.bat --url "https://tomosud.github.io/brdf_view/#v=1&brdfs.0.file=callisto_brdf.brdf&light.theta=60" --view litObject --out out.png

rem 頭部モデルを正面から平行光で
capture.bat --brdf callisto_skin_jacob.brdf --light 90,0 --opt litObject.object=dm.obj --opt litObject.ibl=false --opt plot.nDotL=true --opt litObject.camera.theta=90 --opt litObject.camera.phi=90 --view litObject --out head_090.png

rem BRDF の値（タスク B の比較用）
capture.bat --brdf callisto_brdf.brdf --eval samples.json --eval-out values.json

rem まとめて
capture.bat --batch jobs.json
```

ブラウザの中では:

```js
await brdfView.ready;
await brdfView.setState({ brdfs: [{ file: 'callisto_brdf.brdf' }], light: { theta: 60, phi: 0 } });
const rgb = await brdfView.evaluate({ thetaL: 60, phiL: 0, thetaV: 30, phiV: 180 });
const png = await brdfView.render('slice', { width: 512, height: 512 });
```

## 5. 注意と残っていること

- **`dAniso.brdf` は変更前から壊れている。** GLSL の組み込み関数 `smoothstep` を自分で定義し直しているので、WebGL2 ではどのビューでもコンパイルに失敗する（`shader-builder.ts` の名前の付け替えは `reflect` だけが対象）。今回は手を入れていない。直すなら、付け替えの対象に `smoothstep` を足す
- 測定 BRDF（MERL `.binary`、RGL `.bsdf`）は大きいので URL や状態には入らない。復元時は警告して飛ばす
- 画像は同じ PC・同じ GPU なら同じになる。別の GPU では最下位ビットの差が出うる。コマンドラインは使った GPU を表示する（この PC は RTX 5090、ANGLE / D3D11）
- 平行光の Lit Object の N·L は、全体の「Multiply by N·L」（`plot.nDotL`）に従う。既存の動作のまま
- スキルは、リポジトリ内に置いた。どのフォルダでも使えるようにするなら、`.claude/skills/brdf-view/` を `%USERPROFILE%\.claude\skills\` に写す
- Pages の CI では、`npm ci` が `playwright` のパッケージも入れる（ブラウザ本体はダウンロードしない）。ビルドへの影響は無い
- 最後の見た目の確認（実際のブラウザでの操作感）はユーザーに任せる（CLAUDE.md の決まり）。こちらでは Playwright で UI の操作を 22 項目確かめた

## 6. タスク B へのつなぎ

- 参照実装との数値比較には `evaluate` を使う。`{thetaL, phiL, thetaV, phiV}`（度）か `{L, V, N, X, Y}` を配列で渡すと、`.brdf` の `BRDF()` の生の RGB が返る。`params` で一時的に値を変えられるので、プリセットや `advanced_strength` の振り分けもページを開いたまま回せる
- 光 0°〜150° の掃引は、`--eval` の JSON を Python で作って 1 回で評価するのが速い
- 図（タスク C）は `--batch` のジョブファイルと `--save-state` の JSON を `skin_mat_lean` 側に残せば、作り直せる

## 7. 追記: アドレスバーの自動更新

ユーザーの要望で次を追加した（`web/src/ui/url-sync.ts`）。

- アドレスバーの URL を操作に合わせて書き換える（`history.replaceState`。履歴を増やさず、描画や状態の再適用は起きない）
- アドレスバーに URL を打ち込むと（`hashchange`）、その状態をすぐ適用する
- 表示中の BRDF が外部のもの（開いた `.brdf`、MERL / RGL）のときは書き換えない
- URL（Copy link と `getLink()` を含む）に入れるのは表示中の BRDF だけにした。`getState()` は従来どおり全部を返す
- 確認: Playwright で 10 項目（起動直後の反映、パラメータ・ビューの操作の反映、再読み込みが起きないこと、打ち込んだ URL の適用、外部 BRDF のとき書き換えないこと、表示中だけが入ること）。既存の 22 項目も通る

## 8. 追記: パラメータへの画像（テクスチャ）

ユーザーの要望で、float / color のパラメータに画像をドロップすると Lit Object のモデルに貼られるようにした（第 1 段階: 表示のみ）。

- 仕組み: 画像を貼ったパラメータだけ、Lit Object 用のシェーダで `uniform` をやめて `sampler2D` と同名の普通の変数にし、`main()` の先頭で `texture(..., vUV)` から値を入れる。`.brdf` の本文は変えないので、既存の `.brdf` はすべてそのまま使える。シェーダは「画像を貼ったパラメータの組み合わせ」ごとに作って使い回す
- color は RGB、float は R。値はスライダーと同じ生の値（sRGB の変換なし）。OBJ の UV の向きに合わせて上下を反転して読み込む
- OBJ の `vt` を読むようにした。内蔵の球にも UV を付けた（極が +z。正面のカメラからは極が見える）
- `assets/obj/dm.obj` を、ユーザーが用意した UV 付きの版（`C:\temp\dm.OBJ`）に置き換えた。頂点の数と範囲は元と同じで、法線も滑らかなまま。ファイルは 3.3 MB から 8.2 MB になった
- UI: 行に画像をドロップ → 行の下に見本・ファイル名・`×`（外す）。画像でないファイルは警告して無視する
- API `setTexture(name, src, {brdf, fileName})`、コマンドライン `--texture name=画像`
- 画像は状態 JSON や URL には入らない（状態 JSON にはファイル名だけが出る）。画像を貼っている間はアドレスバーを書き換えない。再読み込みすると画像は外れる
- 確認: 頭部・球・ティーポットに市松模様と粗さのグラデーションを貼って描画（平行光と IBL）。UI のドロップ、外す操作、画像でないファイルの拒否を Playwright で確認。同梱 53 本の全ビュー描画（結果は前と同じ。`dAniso` だけが以前からの失敗）、既存の 22 + 10 項目、ビルド
- 次の段階の候補: IndexedDB への保存、Lit Sphere への対応、ノーマルマップ、color を sRGB として扱う切り替え、タイリング

## 9. 追記: ノーマルマップ、チャンネルの選択、色空間

ユーザーの要望で次を追加した。

- **ノーマルマップ**: すべての BRDF の節の先頭に `normal map` の行を置いた。タンジェント空間（OpenGL、+Y が上）。`DX`（緑の反転）と強さ（XY の倍率）を変えられる。タンジェントは UV から頂点ごとに計算する（`computeTangents`）。OBJ の読み込みでは、位置・UV・法線の値が同じ頂点を共有するようにした（面の角ごとに法線番号を持つ書き出しでもタンジェントが平均される）。`.brdf` には手を入れず、Lit Object のシェーダで法線 N を置き換えてから `BRDF()` を呼ぶ
- **チャンネルの選択**: float のパラメータに画像をドロップすると、R / G / B / A を選ぶ小さな欄が出る（Esc で中止）。あとから見本の行で変えられる
- **色空間**: 画像の色空間は、base color（名前に base color / albedo を含む）が sRGB、それ以外はリニアが既定。見本の行で変えられる。値は `.brdf` が期待する形に直す。同梱の `.brdf` は color のパラメータを `mon2lin` で自分でリニアにしているので、color は「sRGB の値」、float は「リニアの値」が期待値になる。したがって既定（sRGB の base_color、リニアの float）では変換は起きず、リニアの color 画像は sRGB に、sRGB の float 画像はリニアに直してから渡す
- API: `setTexture(name, src, {channel, colorSpace})`、`setNormalMap(src, {flipY, strength})`。コマンドライン: `--texture roughness:g=orm.png`、`--normal-map`、`--normal-flip-y`、`--normal-strength`
- 確認: 一様な色の画像を貼った描画と、同じ値をスライダーで入れた描画を画素で比べ、チャンネル G / B、sRGB の float、sRGB の color、リニアの color のすべてで一致（最大差 0〜1 階調）。ノーマルマップは強さ 0 で元と一致、傾けた画像で陰影が変わり、`DX` で反転することを確認。頭部にこぶ状のノーマルマップを貼り、どの場所でも同じ向きから照らされて見える（タンジェントの向きが揃っている）ことを目で確認。UI（ドロップ、チャンネルの選択と中止、見本での変更、ノーマルマップの DX・強さ・削除）を Playwright で確認。同梱 53 本の全ビュー描画、既存の 22 + 10 + 7 項目、ビルドも通る
- 注意: ほぼ平らなノーマルマップでも、シルエットの縁では N·V の符号が変わって黒くなる画素が出ることがある（ノーマルマップ一般の性質）

## 10. 追記: ノーマルマップの既定を DirectX 形式に

ユーザーの要望で、ノーマルマップの既定を DirectX 形式（`DX` オン、緑チャンネルを反転）にした。UI のドロップ、`setNormalMap`（`flipY` の既定 true）、コマンドライン（既定で反転、`--normal-gl` で OpenGL 形式。`--normal-flip-y` も受け付ける）で共通。
