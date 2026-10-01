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
