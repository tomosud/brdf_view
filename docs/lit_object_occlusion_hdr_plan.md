# Lit Object 遮蔽と HDR 表示の計画（2026-10-01）

Lit Object（IBL）で、モデル自身に遮られて光が届かない箇所（鼻の穴、眼窩、耳の内側、顎の下など）が明るく描かれる問題への対応と、その後の HDR 表示の計画。

## 進め方

1. **C: 頂点ごとの遮蔽 SH を事前計算**（完了）
2. **E: シェーダ内のレイトレースで遮蔽を正確に判定**（完了）
3. **HDR 表示**（次の作業）: (b) WebGL2 のまま HDR 出力できるかを確かめる → 無理なら (a) 表示だけ WebGPU にする
4. **WebGPU 全面移行**は保留（理由は後述）

## 1. C: 遮蔽 SH の事前計算（実装済み）

- `web/src/gl/visibility-bake.ts`: メッシュの読み込み時（`LitObjectView.setMesh`）に GPU で計算する。
  - 512 方向（フィボナッチ球）から、1024² の平行投影の深度マップを描く。
  - 頂点ごとに、法線側の半球で遮られている割合 O(d) を求める（3×3 PCF、法線方向のオフセットと傾きに応じたバイアス付き）。
  - O(d) を実数の球面調和関数（l ≤ 3、16 係数）に射影し、RGBA32F の MRT にピンポンで積算してから読み戻す。
  - 見える割合ではなく、遮られている割合を射影している。遮るものが無い頂点は係数がちょうど 0 になり、凸形状は見た目が変わらない（球で差は最大 1/255 を確認済み）。
  - `EXT_color_buffer_float` が無い環境では null を返し、遮蔽なしで描く。
- `web/public/shaderTemplates/iblObject.vert` / `.frag`: 頂点属性 `vtx_occ0..3` → varying `vOcc0..3`。`occlusionSH(L)` でサンプルごとに `visibility = 1 - clamp(O(L), 0, 1)` を掛ける。SH 基底の式は bake 側の `ACCUM_FRAG` と完全に一致させること。
- `web/src/views/lit-object.ts`: `useOcclusion`（既定 true）、UI のチェック `Occlusion`（`data-testid` は `ctl-occlusion`）、状態キー `litObject.occlusion`。効くのは IBL モードのみ。
- 文書: README.md、docs/ai_control.md に追記済み。
- 限界: 低次の近似なので影は柔らかく、くっきりした影は出ない。相互反射は無いので凹部はやや暗め。No IBL（平行光）には効かない。
- 比較画像: `verify_out/occ/`（`*_cmp.png` は左がオフ、右がオン）。

## 2. E: レイトレースによる遮蔽（実装済み）

### 実装
- `web/src/gl/bvh.ts`: ビン分割 SAH（16 ビン、葉は 4 三角形まで、深さ 48 まで）。ノードは深さ優先で並べ、左の子は i + 1、右の子の番号をノードに持つ。RGBA32F・幅 2048 のテクスチャ 2 枚（ノード 2 テクセル、三角形 3 テクセル = v0, e1, e2）に詰める。三角形は頂点法線に合わせて巻き直し、シェーダで表裏を判定できるようにする。CPU 上の総当たりと一致することを確認済み（dm / myaku / sphere.obj、計 4200 本で不一致 0）。
- `web/src/gl/bvh-worker.ts`: BVH を Web Worker で作る（sphere.obj の 50 万三角形で約 0.9 秒、dm 0.1 秒、myaku 0.2 秒）。Worker が使えなければメインスレッドで作る。Ray を初めて選んだとき（またはモデル読み込み時に Ray なら）だけ作る。作っている間とカメラのドラッグ中は SH で描く。
- `iblObject.frag`: `occlusionMode`（0 Off / 1 SH / 2 Ray）。`occludedRay()` は固定長スタック 48 の any-hit 探索、Möller–Trumbore は表面だけ当てる（裏面カリング）。光が加わるサンプルだけレイを飛ばす。
- 自己交差・terminator 対策: 始点は `dFdx/dFdy(wPos)` から求めた三角形の幾何法線 Ng 方向に `1e-4 × メッシュ半径` ずらす。L が Ng の裏側（スムーズ法線では表側）のときは逆向き（面の内側）にずらす。凸な近傍では裏面にしか当たらず、裏面は数えないので、スムーズ法線との食い違いで影の境界がギザギザにならない。前提として、閉じていて法線が外を向いたメッシュを想定している（開いたメッシュの裏面は遮蔽にならない）。
- TDR 対策: Ray では 1 フレーム 16 サンプル × 512² 画素を上限にする（大きい画像ではさらに減らす）。1 パス（`samples` 個）を数フレームに分け、収束までのサンプル数は Off / SH と同じ（128 × 512）。画面では、フレーム間隔が 25 ms 未満なら 1 回の描画で積算フレームを最大 16 まで増やし、50 ms を超えたら半分に減らす。撮影は 16 フレームごとに `gl.flush()`。
- 積算バッファを RGBA16F から RGBA32F に変えた（数千フレームの平均で半精度だと新しいサンプルが反映されなくなるため）。
- 状態: `litObject.occlusion` は `"off"` / `"sh"` / `"ray"`。`true` → `"sh"`、`false` → `"off"` として読む。UI はセレクト（`data-testid="ctl-occlusion"` は維持）。
- テクスチャユニット: 14 / 15 を BVH に使う（パラメータ画像は 5〜13）。

### 結果（RTX 5090、ANGLE D3D11、512×512、lambert）
- 球（UV 球 100×100）と sphere.obj: Off / SH / Ray の差は最大 1/255。
- 1 パス（128 サンプル）あたり: Off / SH は 1〜5 ms、Ray は球 33 ms、dm 42 ms、myaku 107 ms、sphere.obj 122 ms（16 サンプルのフレーム 1 枚で 4〜15 ms）。収束（512 パス）までの撮影は 16〜82 秒。タイムアウトは起きなかった。
- 比較画像: `verify_out/ray/`（`*_cmp.png` は左から Off / SH / Ray。`*_dark_cmp.png` は露出 -1.5、拡大）。Ray は SH より接触部の影がはっきり出る（眼窩、耳、myaku の球どうしの境目）。シャドウアクネは見られない。
- 遅い GPU では 1 フレームが数百 ms になりうる。問題が出たら `RAY_SAMPLES_PER_FRAME` / `RAY_PIXEL_BUDGET`（`lit-object.ts`）を下げる。

### 当初の計画

### 方針
- `Occlusion` をチェックから 3 択 **Off / SH / Ray** に変える。状態キーは `litObject.occlusion` を残し、互換を保つ（`true` → `"sh"`、`false` → `"off"`、新たに `"ray"`）。`data-testid` は維持する。
- シェーダ側は、可視性 V(L) を掛けている 1 か所（`iblObject.frag` のサンプルループ）を差し替えるだけにする。

### 実装要素（自前で実装、three.js 等の依存は入れない）
1. **BVH の構築（TS）**: 三角形のビン分割 SAH。`setMesh` 時に構築する。25 万三角形で重ければ Web Worker に移す。
2. **GPU への転送**: ノード（AABB、子または三角形の範囲）と三角形の頂点を RGBA32F テクスチャに詰める（幅 2048 程度の 2D 配置、`texelFetch`）。
3. **GLSL の探索**: 固定長スタック（例 32〜64）。影の判定なので、最初に当たった時点で打ち切る（any-hit）。三角形との交差は Möller–Trumbore。
4. **自分自身との誤交差対策**: 光線の始点を `wPos + Ng * eps`（できれば幾何法線）にし、tmin を設ける。スムーズ法線との食い違いで出る影の境界のギザギザ（terminator 問題）に注意する。
5. **GPU タイムアウト（TDR）対策（必須）**: Ray モードでは 1 フレームあたりのサンプル数を減らし（例 16〜32）、総サンプル数はフレーム数で稼ぐ。今は `numSamples` × `MAX_ACCUM_FRAMES`（128 × 512）。Ray モード用にこの比を変えるか、積算フレーム数の上限を引き上げる。
6. **任意**: カメラ操作中は SH で描き、止まったら Ray で積算する。

### 確認
- 球（凸形状）で Off / SH / Ray が一致する。
- dm.obj、myaku.obj、sphere.obj（25 万頂点）で、Ray の見た目と、操作時の重さやフレームの落ち方を確かめる。
- `capture.bat --opt litObject.occlusion=ray ...` で撮れる（ヘッドレス撮影は一度に全フレームを回すので、TDR に注意）。
- `npm run build` が通る。docs/ai_control.md と README.md を更新する。

## 3. HDR 表示（完了）

対象ビューは Image Slice、Lit Object、Lit Sphere。トーンマップは ACES 2.0 とし、オン / オフできるようにする。段階に分けて進め、各段階の終わりで確認する。

1. **① SDR のまま ACES 2.0 トーンマップのオン / オフ**（完了）
2. **② WebGL2 の HDR 出力が Chrome で使えるか調べる**（完了: 使える → (b) で進める）
3. **③ HDR 表示**（完了。実機の HDR モニターで確認済み）

### ① ACES 2.0 トーンマップ（実装済み）
- 決めたこと（ユーザーと合意）: 切り替えは全体で 1 つ（ツールバー「Tone map (ACES 2.0)」、状態キー `display.toneMap`、既定オフ）。オンのときは sRGB の区分関数で符号化し、Gamma は無効（灰色）。Exposure はトーンマップの前。
- `web/src/gl/aces2.ts`: ACES 2.0 の CTL（aces-aswf/aces-core、Apache-2.0）を TypeScript に移植。パラメータと色相テーブル（カスプ、到達範囲の M、上側のガンマ）の初期化（約 15 ms）と、CPU 版の順変換（検証用の基準）。ピーク輝度と制限原色を引数に取るので、③ の HDR 版にもそのまま使える。
- `web/src/gl/tonemap.ts`: 1 画素分の順変換の GLSL（`TONEMAP_GLSL`）と、ユニフォーム・テーブル（362×2 の RGBA32F、ユニット 13）を設定する `ToneMapper`。テンプレートには `::INSERT_TONEMAP_HERE::` で入れる（Lit Sphere、Image Slice の高さ表示）。Lit Object と Image Slice の表示パスは TS 内のシェーダに埋め込む。
- 入力: 描画結果をリニア Rec.709 とみなし、OCIO の「Linear Rec.709 (sRGB)」→「ACES2065-1」の行列（CAT02）で AP0 にする。
- 検証: OCIO 2.6（ACES studio config v4.0.0 = ACES 2.0、v5.0.0 = ACES 2.1 も同じ結果）の「sRGB - Display」/「ACES 2.0 - SDR 100 nits (Rec.709)」と、4008 色（2^-10〜2^10 倍、彩度の高い色、色域の境界を含む）で比べた。CPU 版の最大誤差 3.5e-4、GPU（RTX 5090、ANGLE D3D11）の最大誤差 3.5e-4（どちらも 0.09/255）、GPU と CPU の差 2.7e-5。NaN なし。
- 比較画像: `verify_out/tonemap/`（`*_cmp.png` は左がオフ、右が ACES 2.0）。

### ② WebGL2 の HDR 出力の調査（2026-10-01、完了）
- 調査用ページ: `web/tools/hdr-probe.html`（開発サーバーでだけ開ける。本番ビルドには入らない）。リニアの 0.5〜16 のパッチを、A 標準 WebGL2 / B WebGL2 + `drawingBufferStorage(RGBA16F)` / C B + 使える HDR 指定 / D RGBA16F にリニア値 / E WebGPU `rgba16float` + `toneMapping: extended` で描く。
- Chrome 154（Windows 11、HDR オン、HDR モニター）で目視: **B・C・D・E で 1 を超えるパッチが段階的に明るく見えた**。A は 1 から右が同じ白。
- 分かったこと:
  - WebGL2 は `gl.drawingBufferStorage(gl.RGBA16F, w, h)` だけで HDR 表示になる（B）。値は拡張 sRGB（sRGB の符号化を 1 の外へ延長、1.0 = SDR の白）として扱われる。特別なトーンマップ指定は要らない。
  - `drawingBufferToneMapping`、`canvas.configureHighDynamicRange` は無い。`drawingBufferColorSpace` は `srgb` / `display-p3` だけ（`srgb-linear` は不可）。CSS `dynamic-range-limit` は設定できるが、B で既に効いているので要らない。
  - WebGPU（E）も動くが、WebGL2 で足りるので計画 (a) は不要。
  - モニターのピーク輝度や SDR の白の明るさは、ブラウザからは取れない（`matchMedia('(dynamic-range: high)')` で HDR 表示かどうかだけ分かる）。
- 結論: **(b) WebGL2 のまま HDR 表示にする**。

### ③ HDR 表示（実装済み）
- 決めたこと（ユーザーと合意）: ACES 2.0 の HDR 版は P3-D65・1000 nits（公式プリセット「P3-D65 1000 nits in P3-D65 sRGB-Piecewise」と同じパラメータ）。画面の 1.0 = SDR の白 = **203 nits**（ITU-R BT.2408、Chrome の既定）。ACES の `linear_scale_factor` を 100/203 にするのと同じ。切り替えはツールバーの `HDR`（状態キー `display.hdr`、既定オフ、`data-testid="ctl-hdr"`）。
- 表示の組み合わせ（`src/gl/tonemap.ts` の `DisplayMode` = シェーダの `toneMapMode`）:
  - 0 SDR: 今まで通り（Gamma、0〜1 に切り詰め）
  - 1 ACES SDR: 100 nits・Rec.709・sRGB
  - 2 ACES HDR: 1000 nits・P3-D65。描画バッファは RGBA16F・`display-p3`、拡張 sRGB で符号化（最大 1.995 = 1000 nits）
  - 3 HDR（トーンマップなし）: 0 から 1 での切り詰めを外しただけ（RGBA16F・`srgb`）
- `BaseView`（`supportsHdr` のビュー = Lit Object / Lit Sphere / Image Slice）が毎フレーム、描画バッファの形式（`drawingBufferStorage`）と色空間（`drawingBufferColorSpace`）を合わせる。HDR になるのは、HDR がオン、`matchMedia('(dynamic-range: high)')` が真、撮影中でない、のすべてを満たすとき。モニター間の移動（`change` イベント）で切り替わる。
- 撮影（PNG、`render()`、`capture.bat`）は常に SDR。HDR オンでも同じ PNG になることを確認した。
- シェーダの共通関数: `displayEncode(rgb, gamma)`（Gamma または ACES）と `displayLimit(c)`（SDR は 0〜1、HDR は 0 以上）。4 か所の表示（Lit Object・Image Slice の表示パス、Lit Sphere・Image Slice 高さ表示のテンプレート）はこれを使う。
- 検証: ACES HDR 版を OCIO「Display P3 HDR - Display」/「ACES 2.0 - HDR 1000 nits (P3 D65)」と 4008 色で比べた（203 の倍率を戻して比較）。CPU・GPU とも相対誤差は最大 0.086%（0.5/255 未満）、NaN なし。アプリ内では、HDR 表示を擬似的に有効にして、形式・色空間の切り替え、1 を超える値が描画バッファに入ること（Tone map オフで最大 2.23、ACES HDR で最大 1.40）、撮影後に HDR に戻ることを確認した。
- 実機確認: Chrome 154、Windows 11（HDR オン）、HDR モニターで、ユーザーが見た目を確認した（2026-10-01）。


- **(b) まず確かめる**: Chrome で WebGL キャンバスの HDR 出力（float の描画バッファ、拡張範囲のトーンマッピング指定など）が正式に使えるか。使えれば WebGL2 のまま、表示のシェーダから clamp を外すだけで済む。
- **(a) 駄目なら**: 描画は WebGL2 のままにし、表示だけ WebGPU キャンバス（`rgba16float`、`toneMapping: { mode: 'extended' }`）にする。WebGL と WebGPU は画像を直接共有できないため、浮動小数の `readPixels` で読み戻し、`writeTexture` で渡す。読み戻しは処理を止めるので、積算中は 10 Hz 程度に間引く。
- **決めること**: 1 を超える値の見せ方（基準白の明るさ、Exposure と Gamma の意味、clamp を外すか）。HDR に対応しない環境（他のブラウザ、SDR モニタ）では今の表示に戻す。HDR 出力のオン / オフを状態キーに持たせるか。
- 撮影（PNG）は今まで通り SDR。必要なら別途 EXR / float での書き出しを検討する。

## 4. WebGPU 全面移行（保留）

- 最大の壁は、`.brdf` の BRDF 関数が GLSL で書かれていること。WebGPU は WGSL しか受け付けないため、利用者が書いた任意の GLSL を実行時に WGSL へ変換する必要がある（WebAssembly 化した naga などを同梱）。変換できない書き方への対応も要る。
- 全ビュー（プロット類を含む）、測定 BRDF、`window.brdfView`、capture.mjs まで移植対象になる。
- GLSL の扱いの目処が立つまで着手しない。
