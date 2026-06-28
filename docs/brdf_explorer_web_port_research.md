# BRDF Explorer Web App Port Research

対象: `sample/brdf-main`

目的: Disney BRDF Explorer の挙動を、GitHub Pages でホストできる静的 Web アプリとして再現する方法を調査する。ここでは実装は行わず、元アプリの構造、再現すべき挙動、Web 移植時の技術課題、実装方針を整理する。

更新日: 2026-05-31

現状メモ: 2026-06-28 時点の Web 版では `ALBEDO` view は廃止済み。
この文書は元 Disney BRDF Explorer の移植調査メモとして残すが、現在の
Cartesian plot は `Theta V / Theta H / Theta D` のみを実装対象とする。

## 結論

GitHub Pages でのホストは可能。サーバ側処理は不要で、HTML/CSS/JavaScript/WebAssembly/静的アセットだけで構成できる。

ただし、元アプリは Qt + OpenGL 4.1 前提で、WebGL にそのまま存在しない機能を使っている。特に次の差分は、簡易化ではなく同等ロジックへの置き換えが必要になる。

- Geometry Shader: WebGL では使えないため、太線・テキスト・プロット線の展開を WebGL2 の頂点シェーダ/インスタンシング用データ構造へ移す。
- `samplerBuffer` / `GL_TEXTURE_BUFFER`: WebGL2 には同等 API がないため、MERL/異方性 measured データを 2D float texture に詰め替え、`texelFetch` で 1D index を再現する。
- GLSL 410: WebGL2 の GLSL ES 3.00 へテンプレートを機械変換し、`in/out`, precision, texture format, integer loop などを合わせる。
- Environment probe: 元アプリは Ptex `.penv` を読むが、Web 版の主入力は通常 HDRI に寄せる。Radiance RGBE `.hdr` や OpenEXR `.exr` の equirectangular map を読み、cubemap と importance sampling 用 CDF/probability texture を生成する。元同梱 `.penv` は比較用に build-time 変換する方針がよい。
- Qt dock UI: 同等のビュー構成と相互作用を Web UI と複数 canvas で再構成する。

最も現実的で再現性が高い方針は「Emscripten で Qt アプリを丸ごと動かす」ではなく、「元の BRDF/シェーダ/データ処理を WebGL2 向けに移植する」こと。理由は、元アプリが OpenGL 4.1 の geometry shader と texture buffer に強く依存しており、Qt for WebAssembly 経由でも WebGL ターゲットでは同じ GL 機能をそのまま出せないため。

2026-05 時点では WebGPU も実装候補に見えるが、初期実装の主ターゲットにはしない。WebGPU は GPU compute や storage buffer が使えるため measured BRDF や IBL accumulation には魅力がある。一方、WebGPU の shader は WGSL であり、元 `.brdf` の任意 GLSL 断片をテンプレートへ差し込む設計と相性が悪い。GLSL 断片を WGSL へ変換するには別の compiler/transpiler 問題が発生するため、まず WebGL2 + GLSL ES 3.00 で元設計を保つ。WebGPU は将来の別 backend として検討する。

## Windows exe の同梱状況

ローカルの `sample/brdf-main` には Windows 実行ファイルは同梱されていない。`*.exe`, `*.dll`, `*.zip`, `*.msi`, `*.7z`, `*.tar.gz` を検索したが、配布バイナリは見つからなかった。

外部情報としては、2012 年当時に `brdf-1.0.0-win32.zip` という 32-bit Windows バイナリが GitHub Downloads で公開されていた記録がある。CG Channel は「binary available」「32-bit Windows only」と書いており、日本語の利用記事や授業資料にも `brdf.exe` を含む zip として言及がある。ただし現在は GitHub の releases/tags API に配布物はなく、旧 URL `https://github.com/downloads/wdas/brdf/brdf-1.0.0-win32.zip` は 404 になる。

この環境でのビルド可否も確認した。

- `qmake`: PATH になし
- Visual Studio compiler `cl`: PATH になし
- `nmake`: PATH になし
- `mingw32-make`: PATH になし
- `ninja`: PATH になし
- `cmake`: あり。ただしこのプロジェクトは qmake `.pro` ベース

`README-WIN32` では Windows ビルドに Qt 4.8.1, GLEW 1.9.0, ZLib 1.2.5, GLUT 3.7, Visual Studio 2010 command prompt が必要とされている。現在の `src/brdf/brdf.pro` は `CONFIG += qt5` になっているが、どちらにせよ qmake と C++ compiler がないため、この環境だけでは exe を作成できない。比較用の exe が必要なら、次のどちらかが必要。

- Qt/qmake + MSVC または MinGW を導入してこのソースをビルドする
- 旧 `brdf-1.0.0-win32.zip` の信頼できるミラー/アーカイブを入手する

その後、比較対象用の Windows exe はローカルで作成済み。MSYS2 UCRT64 + MinGW + Qt5 でソース修正なしにビルドし、直接起動しやすい runtime フォルダとして `build/brdf-runtime/brdf.exe` を用意した。配布用には `dist/brdf-runtime.zip` を作成し、GitHub Releases の `BRDF Explorer Runtime v0.1.0` に asset として添付した。詳細手順は `docs/windows_exe_build.md` にまとめた。

追加調査では、旧バイナリを安全に直接取得できる現役 URL は見つからなかった。見つかったのは次の「存在証跡」まで。

- DF TALK の記事: `brdf-1.0.0-win32.zip` を展開し、`brdf.exe` を起動する手順を説明している
- フランス語の授業資料: `https://github.com/downloads/wdas/brdf/brdf-1.0.0-win32.zip` を Windows 用として指定している
- Disney 公式ページのミラー: source code または win32 binary を GitHub から取得できる、と説明している
- CG Channel の 2012 年記事: バイナリは 32-bit Windows only と説明している

一方で、旧 GitHub Downloads URL は現在 404 で、元 upstream の GitHub releases/tags も空。したがって、今から比較用バイナリを使う場合は、非公式ミラーを無理に探して実行するより、ソースから再現ビルドした今回の `build/brdf-runtime/brdf.exe` / Release asset `brdf-runtime.zip` を基準にする方が安全。

Guix には `brdf-explorer` パッケージが存在する。これは Linux 環境での再現ビルドや依存関係の把握には参考になるが、GitHub Pages で動く Web アプリのベースや Windows exe の代替にはならない。

## 既存 Web 実装の調査

### Patapom WebGL BRDF Explorer

URL: https://patapom.com/topics/WebGL/BRDF/

見つかった中では最も近い Web ベース実装。WebGL で 3D view、2D view、BRDF graph、MERL BRDF、IBL 風の renderer、fitting、複数の analytic model を持っている。ページ HTML から `BRDF.BRDFBase`, `BRDF.RendererBRDF`, `BRDF.RendererGraph`, `BRDF.Renderer3D`, `BRDFPropertiesAnalytical`, `BRDFPropertiesPom` などの JS モジュールを読み込んでいることが確認できる。

ただし、Disney BRDF Explorer の直接移植ではない。

- `.brdf` ファイルを読み込んで GLSL 断片をテンプレートへ差し込む仕組みは見当たらない
- UI は BRDF model/fitting パラメータ中心で、Disney 版の dock/tab 構成とは異なる
- 元 Disney 版の `Theta V/H/D`, `Albedo`, `Image Slice`, Ptex `.penv` probe, `.bparam` 互換とは一致しない
- ソースはページ上に公開されている JS として読めるが、明確な GitHub repository やライセンス表示は検索では確認できなかった

利用方針としては「そのまま採用」ではなく、以下を参考にする程度が妥当。

- WebGL での BRDF 2D/3D 表示 UI
- MERL データを WebGL で扱う設計
- 既存の WebGL BRDF viewer としての操作感

ライセンスが不明なため、コードの直接取り込みは避けるべき。

### BRDFLab

URL: https://brdflab.sourceforge.net/

Analytical / Measured / Simulated BRDF の表示、fit、point light/environment map rendering を持つ既存ツール。ただし Web アプリではなく、Ogre3D + Qt のデスクトップアプリ。今回の GitHub Pages 版の直接ベースにはならない。

### その他

CMU の `BRDF Toy` や各種 PBR/WebGL demo は見つかるが、Disney BRDF Explorer 互換の `.brdf` ローダ、MERL/異方性 measured data、複数グラフ view、image slice、IBL object view まで揃うものは確認できなかった。

結論として、既存 Web 実装を流用して短縮できる可能性があるのは Patapom 版の設計調査くらい。今回の目的が「Disney BRDF Explorer の挙動再現」である限り、コアは独自に WebGL2 移植する必要がある。

### 採用判断

今回の Web 版では、Patapom 版を直接 fork/流用する方針は取らない。理由は `.brdf` 互換、shader template 注入、元 Disney 版の environment/probe 互換、複数 plot view が揃っておらず、ライセンスも明確に確認できないため。

ただし、次の用途では参考にする価値がある。

- WebGL で BRDF 形状を 2D/3D 表示する UI/UX の比較対象
- MERL や BRDF graph をブラウザで扱う際の性能感
- GitHub Pages 上で「Web BRDF Explorer」として見せる画面構成の参考

実装方針としては、`sample/brdf-main` の `.brdf` parser、shader template、view ごとの数式・サンプリング・UI 状態を一次ソースとして移植する。既存 Web 実装は補助調査に留める。

## 元アプリの構造

エントリポイントは `src/brdf/main.cpp`。起動時に `data/teapot.obj` を開けるか確認し、`MainWindow` を生成する。`MainWindow` は Qt dock widget で次のビューを並べる。

- `BRDF Parameters`: `ParameterWindow`
- `3D Plot`: `Plot3DWidget`
- `Polar Plot`: `PlotPolarWidget`
- `Theta V`, `Theta H`, `Theta D`, `Albedo`: `PlotCartesianWindow` / `PlotCartesianWidget`
  - 現在の Web 版では `Albedo` は廃止済み。元アプリ側の構造としてのみ記録する。
- `Lit Sphere`: `LitSphereWindow` / `LitSphereWidget`
- `Image Slice`: `ImageSliceWindow` / `ImageSliceWidget`
- `Lit Object`: `IBLWindow` / `IBLWidget`

`ParameterWindow` は BRDF リスト、入射角、チャンネル、log plot、`N.L` 乗算を保持し、各ビューへ signal で状態を配る。Web 版ではこの部分を単一の state store に置き換え、各 canvas view が同じ状態を subscribe する構造にすると元のイベント伝播を保ちやすい。

## BRDF ファイルと shader 生成

`.brdf` は `BRDFBase::loadBRDF` と `BRDFAnalytic` が読む。

形式は次の通り。

- 先頭行: `analytic`
- `::begin parameters` / `::end parameters`
- `float name min max default`
- `bool name default`
- `color name r g b`
- `::begin shader` / `::end shader`
- 任意 GLSL 断片。ただし `vec3 BRDF(vec3 L, vec3 V, vec3 N, vec3 X, vec3 Y)` を定義する前提。
- 任意で `::begin isFunc` / `::end isFunc`。IBL の BRDF importance sampling 用。

`BRDFBase::compileShader` はテンプレート中の `::INSERT_UNIFORMS_HERE::`, `::INSERT_BRDF_FUNCTION_HERE::`, `::INSERT_IS_FUNCTION_HERE::` を置換して shader を組み立てる。Web 版でもこの仕組みをそのまま残すべき。つまり BRDF は JavaScript 側で数式を再実装するのではなく、GLSL 断片として shader に注入し、GPU で評価する。

Web 版で必要な処理:

- `.brdf` parser を TypeScript/JavaScript に移植する。
- parameter 定義から UI control と uniform declaration を生成する。
- GLSL 410 テンプレートを GLSL ES 3.00 に移植する。
- 読み込んだ BRDF 断片は可能な限り原文を保持し、必要最小限の互換変換だけを行う。
- shader compile log を UI 上で表示する。元アプリは標準出力に近いが、Web では compile error が主なデバッグ手段になる。

## 対応すべきデータ形式

`createBRDFFromFile` は拡張子で分岐する。

- `.brdf`: analytic BRDF
- `.bparam`: parameter 保存ファイル。1 行目に元データファイル、以降に parameter 値
- `.binary`: MERL measured BRDF
- `.dat`: MIT CSAIL anisotropic measured BRDF
- `.tif`: image slice。ただし現在の `BRDFImageSlice::loadImage` は実ファイルを読まず、90x90 の固定色データを作るだけ

MERL `.binary` はヘッダ `int dims[3]` のあとに RGB double 配列を読む。想定サンプル数は `90 * 90 * 360 / 2 = 1,458,000`。元 shader は `measured.func` で `samplerBuffer measuredData` から R/G/B の連続領域を `texelFetch` する。

WebGL2 では 1D buffer texture が使えないため、次のように再現する。

- double を JavaScript の `DataView` で little-endian 読み込みし、`Float32Array` へ変換する。
- 1D 配列を `R32F` 2D texture にパックする。
- shader 側に `sampler2D measuredDataTex` と `ivec2 indexToCoord(int index)` を追加し、元の `texelFetch(measuredData, index).r` を `texelFetch(measuredDataTex, indexToCoord(index), 0).r` に置換する。
- `RED_SCALE`, `GREEN_SCALE`, `BLUE_SCALE` は元 shader の定数を維持する。

異方性 `.dat` は 16 個の int header と float RGB データ。元アプリは `BRDFMeasuredAniso::loadAnisoData` で header を読み、`measuredAniso.func` で固定寸法 `45,45,180,90` として参照する。データ量が大きい可能性が高いため、GitHub Pages に全部同梱するより、ユーザのローカルファイル読み込みを主経路にするのが妥当。ただし再現性のため、ブラウザ側でバイナリをそのまま読める parser は必要。

## 各ビューの再現方法

### 3D Plot

元実装: `Plot3DWidget`

- `geodesicHemisphere.h` の 40 三角形を 6 回 subdivide して半球メッシュを作る。
- vertex shader `brdftemplate3D.vert` で各方向の BRDF 値を評価し、半径方向へ変位する。
- fragment shader `brdftemplate3D.frag` は微分から法線を作り、簡易 Phong shading を行う。
- 入射方向、法線、反射方向、U/V 軸、単位円、床 plane を描画する。
- 左 drag で回転、右 drag で zoom、double click で reset。

Web 版:

- 半球 subdivision と軸 line data を JS 側で同じ手順で生成する。
- `brdftemplate3D.vert/frag` を GLSL ES 3.00 に移植し、BRDF 注入を維持する。
- 軸と単位円の太線は geometry shader ではなく、line segment quad を生成する専用 shader へ置き換える。

### Polar Plot

元実装: `PlotPolarWidget`

- 半円の補助線と入射/反射ベクトルを描く。
- BRDF 曲線は `brdftemplate2D.vert` で角度ごとの BRDF 値を半径として評価する。
- `GL_LINE_STRIP_ADJACENCY` + `brdftemplatePlot.geom` でアンチエイリアス付き太線にしている。
- 左 drag で pan、右 drag で zoom、double click で reset。

Web 版:

- 元と同じ 0..360 の角度サンプルを使う。
- Geometry shader の miter 計算を、WebGL2 vertex shader に移す。各描画頂点に `prev/start/end/next` を attribute として渡し、clip space に変換した後に元 `brdftemplatePlot.geom` と同じ miter 計算を行う。
- fragment の alpha falloff は `brdftemplateAnglePlot.frag` と同じ式を使う。

### Cartesian Plots

元実装: `PlotCartesianWidget`

- `THETA_V_PLOT`, `THETA_H_PLOT`, `THETA_D_PLOT`, `ALBEDO_PLOT` の 4 種。
- x 範囲は基本 `[-pi/2, pi/2]`。
- `Theta H` は 0 付近にサンプルを寄せるため `theta *= theta * (1/(0.5*pi)) * sign` を使う。
- Albedo は shader 側で sampling mode と sample count を使う。
- 軸とラベルは `Text.*` shader と `verasansmono.png` で描く。
- Ctrl + left/right drag で x/y scale を変更する。

Web 版:

- データ線サンプル生成、軸 tick、zoom/pan/scale の計算を元コードから移植する。
- `Text.geom` は WebGL で使えないため、文字ごとの quad をインスタンス描画する。フォント画像 `verasansmono.png` とセル計算は維持する。
- `ALBEDO` は現在廃止済み。Monte Carlo 積分を含む巨大 shader が通常 `.brdf` の初回 compile を重くしていたため、Web 版では `Theta V / Theta H / Theta D` のみを残す。

### Lit Sphere

元実装: `LitSphereWidget`

- `Sphere` mesh を `brdftemplatesphere.vert/frag` で描画する。
- 最上位の enabled BRDF だけを使用する。
- `brightness`, `gamma`, `exposure`, `doubleTheta`, `useNDotL` を持つ。
- sphere 上を左 drag すると入射角を更新する。`doubleTheta` 有効時は highlight がマウス位置に追従する。

Web 版:

- Sphere mesh 生成を移植するか、元 `Sphere` と同じ lat/long 100/100 mesh を生成する。
- 一覧上で topmost enabled BRDF を選ぶ規則を維持する。
- マウス位置から unit sphere 座標を作る `toThetaPhi` ロジックを同じにする。

### Image Slice

元実装: `ImageSliceWidget`

- half angle を x、difference angle を y とする 2D 表示。
- `phiD`, `brightness`, `gamma`, `exposure`, `useThetaHSquared`, `showChroma` を持つ。
- `BRDFImageSlice::loadImage` は現状 `.tif` を読んでおらず、90x90 の固定色データを作るだけ。

Web 版:

- analytic/measured BRDF に対する image slice shader はテンプレート移植で再現する。
- `.tif` 入力については「元コード同等」なら固定色挙動を再現することになる。実用機能として TIFF を読むなら、それは元コード以上の拡張であり、別要件として扱う。

### Lit Object / IBL

元実装: `IBLWidget`

- `SimpleModel` で OBJ を読み、unitize して triangle VBO 化する。
- default model は `sphere.obj`、probe は `beach.penv`。
- rendering mode:
  - `No IBL`
  - `IBL: No IS`
  - `IBL: IBL IS`
  - `BRDF IS` と `MIS` は UI/フラグはあるが shader 内では未実装相当で色を返すだけ
- IBL は progressive accumulation。`stepSize = 271`, `totalSamples = stepSize * 15`。
- 環境 map は Ptex `.penv` から 6 faces の float RGB を読み、cubemap と probability texture を作る。
- 確率 texture は cube distortion を補正しつつ luminance から conditional/marginal inverse CDF を作る。
- `GL_RGBA32F` FBO にサンプルを蓄積し、`IBLResult.frag` で表示する。

Web 版:

- OBJ parser は `SimpleModel` と同じ対応範囲を実装する。`v`, `vn`, `f` の `v//n`, `v/t/n`, `v/t`, `v` を読み、fan triangulation する。
- IBL の主入力は Ptex `.penv` ではなく、通常 HDRI にする。Ptex は元アプリ互換・比較用の入力形式として扱い、ユーザ向けの標準入力にはしない。
- 主対応形式は Radiance RGBE `.hdr` equirectangular map がよい。理由は parser が比較的薄く、Web で `ArrayBuffer` から RGBE/RLE を読んで `Float32Array` の linear RGB に展開しやすいこと、HDRI 素材として一般的なこと。
- OpenEXR `.exr` は追加対応候補。映画/VFX 由来の scene-linear HDR 形式として強いが、parser が重くなるため初期実装では `.hdr` を先に通す。既存 loader を使う場合もライセンスと bundle size を確認する。
- 配布効率を優先する同梱 environment は、build-time に equirectangular HDRI から cubemap、mip chain、importance sampling texture へ変換して静的 asset 化する。KTX2 は GPU texture container として有力だが、Basis Universal transcode に WASM が必要になる場合があるため、最初は独自の float binary または uncompressed cubemap asset の方がデバッグしやすい。
- 元同梱 `beach.penv` / `furnace.penv` / `spot.penv` は、Web 版の比較用に build-time converter で cubemap float data と probability textures へ変換する。これなら IBL の見た目比較に必要な environment は保てる。
- 任意 `.penv` をブラウザ内で開く機能は後回しにする。必要になった場合だけ、同梱 `src/brdf/ptex` reader の WASM 化を検討する。Ptex decode を初期実装の必須経路にすると、Web 移植の主課題が renderer ではなく独自形式 decoder になってしまう。
- HDRI からの sampling texture 生成は元の `.penv` 経路と同じ意味を保つ。入力が equirectangular の場合は、各 texel の luminance と球面上の面積重みを使って marginal/conditional CDF を作り、shader 側の `IBL: IBL IS` は元と同様に probability texture を参照する。
- WebGL2 では float render target の extension が必要。`EXT_color_buffer_float` を必須要件として扱い、なければ再現不能として明示エラーにする。
- HDRI cubemap を線形補間するなら `OES_texture_float_linear` も検査する。使えない環境では nearest sampling になり、IBL の見た目差が大きくなるためフォールバック扱いではなく要件不足として止める。
- WebGL2 は seamless cube map sampling を含むため、旧メモのように `GL_TEXTURE_CUBE_MAP_SEAMLESS` の不在だけを問題視する必要は薄い。ただし、Ptex `.penv` 由来の face 配置や equirectangular -> cubemap 変換時の face 境界、mipmap 生成、probability texture の面積重みがずれると継ぎ目や明るさ差が出る。比較検証では cube face 境界と sampling CDF を重点的に見る。

## WebGL2 への shader 移植方針

元 shader は `#version 410`。WebGL2 は `#version 300 es` を使う。

機械変換の基本:

- `#version 410` -> `#version 300 es`
- fragment shader に `precision highp float; precision highp int;` を追加
- `out vec4 fragColor;` は維持可能
- `in/out` は GLSL ES 3.00 に合わせて維持
- `textureLod` は WebGL2 で使用可能
- unsigned integer 演算は WebGL2 で使用可能。ただし loop condition と cast は実機検証が必要
- geometry shader は移植しない。対応する vertex shader/attribute layout を新規設計する
- `samplerBuffer` は `sampler2D` + index packing に変換する

`.brdf` のユーザ GLSL は任意コードなので、完全な GLSL parser を最初から書く必要はない。まずは元テンプレート側で API 差を吸収し、必要な変換を限定する。

ただし、`.brdf` 内に GLSL 410 固有機能が書かれている場合は WebGL2 で compile error になる。サンプル `src/brdfs/*.brdf` は基本的な GLSL 関数中心で、WebGL2 へ通しやすい。

## UI 再現

Qt dock をそのまま再現する必要はないが、状態と操作は再現する。

必要な UI:

- BRDF file open。複数ファイル対応
- 同梱 sample BRDF の一覧読み込み
- BRDF ごとの visible、solo、solo RGB channels、reload、reset、save `.bparam` 相当
- float slider + numeric input。Ctrl+click reset 相当も入れる
- bool checkbox
- color picker
- channel selection: Red, Green, Blue, Luminance
- log plot checkbox
- Multiply by `N . L` checkbox
- incident theta/phi control
- view tabs/panels: 3D, Polar, Theta V/H/D, Lit Sphere, Image Slice, Lit Object
  - `Albedo` は元アプリにはあるが、現在の Web 版では廃止済み。
- Lit Sphere controls: brightness, gamma, exposure, double theta, use `N.L`
- Image Slice controls: phiD, brightness, gamma, exposure, thetaH squared, chroma
- IBL controls: rendering mode, keep sampling, model open, probe open, gamma, exposure

状態の順序も重要。`ParameterWindow::getBRDFList` は UI 上の順に enabled BRDF を集める。Lit Sphere/Image Slice/IBL は topmost enabled BRDF だけを見る。3D/Polar/Cartesian は複数 BRDF を重ねる。

## GitHub Pages 構成案

静的配信で成立する構成:

```text
web/
  index.html
  src/
    app.ts
    state/
    brdf/
      parser.ts
      shader-builder.ts
      measured-merl.ts
      measured-aniso.ts
      bparam.ts
    gl/
      renderer.ts
      shaders/
      line-expansion.ts
      textures.ts
    views/
      plot-3d.ts
      plot-polar.ts
      plot-cartesian.ts
      lit-sphere.ts
      image-slice.ts
      ibl.ts
    io/
      obj.ts
      env-hdri.ts
      env-cubemap.ts
      env-sampling.ts
      penv-convert.ts
  public/
    brdfs/
    shaderTemplates/
    data/
    images/
    probes/
    environments/
    LICENSE
    NOTICE
```

ビルド成果物は `dist/` に出し、GitHub Pages は `dist` を公開する。GitHub Pages は static files を配るだけなので、Vite などで relative base path を設定する。

`probes/` は元 BRDF Explorer の `.penv` 由来 asset を置く場所として残す。Web 版の主環境 map は `environments/` に置き、`.hdr` / `.exr` / 事前変換 cubemap asset を扱う。初期実装では `.hdr` と事前変換 cubemap asset を優先し、任意 `.penv` のブラウザ内 decode は必須にしない。

## 必須ブラウザ機能

フォールバックで簡易表示に落とさない前提なら、起動時に次を検査し、足りなければ明示的に停止する。

- WebGL2
- `EXT_color_buffer_float`
- `OES_texture_float_linear`
- float texture sampling
- vertex array object / instancing
- sufficient `MAX_CUBE_MAP_TEXTURE_SIZE` for HDRI/cubemap probes
- sufficient `MAX_TEXTURE_SIZE` for measured BRDF 2D packing
- sufficient fragment shader precision
- secure context。GitHub Pages は HTTPS 配信なので満たせる。WebGPU を将来 backend にする場合は特に必須になる。

公式参照:

- MDN WebGL2: https://developer.mozilla.org/en-US/docs/Web/API/WebGL2RenderingContext
- MDN `EXT_color_buffer_float`: https://developer.mozilla.org/en-US/docs/Web/API/EXT_color_buffer_float
- MDN `OES_texture_float`: https://developer.mozilla.org/en-US/docs/Web/API/OES_texture_float
- MDN WebGPU: https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API
- MDN secure contexts: https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts/features_restricted_to_secure_contexts
- Khronos KTX: https://www.khronos.org/ktx/
- Khronos WebGL: https://www.khronos.org/webgl/
- Khronos WebGL 2.0 feature overview: https://www.khronos.org/blog/webgl-2.0-arrives
- OpenEXR: https://openexr.com/en/latest/
- Radiance RGBE format reference: https://radsite.lbl.gov/radiance/refer/filefmts.pdf
- GitHub Pages docs: https://docs.github.com/en/pages

## ライセンスと配布時の注意

`sample/brdf-main/LICENSE` は Disney Enterprises の独自ライセンスで、再配布時に copyright/patent/trademark/attribution notices を保持する必要がある。`README` には light probe attribution もある。Web アプリとして配布する場合も、少なくとも次を同梱/表示する。

- `LICENSE`
- `LICENSE-BINARY`
- `README` の light probe attribution
- `.brdf` ごとのライセンスコメント。`disney.brdf` は Apache License 2.0 に Section 6 Trademarks の変更が入っている

また、ライセンスは contributor の商標利用権を許諾しないため、アプリ名や表示で Disney の商標的扱いを避ける。説明文として原典 attribution を置くのは必要。

## 実装順序

1. WebGL2 renderer の基盤を作る。shader compile/link log、uniform setter、texture/FBO wrapper、resize/devicePixelRatio 対応。
2. `.brdf` parser と shader template builder を移植する。まず `lambert.brdf` と `disney.brdf` が compile できるところまで。
3. 3D Plot を移植する。半球 mesh、BRDF 変位、axis/plane を再現する。
4. Polar/Cartesian を移植する。geometry shader 由来の太線を vertex shader/instanced quad へ置換する。
5. Parameter UI と state propagation を作り、複数 BRDF、visible、solo、channel mask、log plot、`N.L` をつなぐ。
6. Lit Sphere を移植する。
7. MERL `.binary` loader と `samplerBuffer` 代替 texture packing を実装する。
8. Image Slice を移植する。`.tif` は元挙動として固定色を再現し、必要なら別途 TIFF 対応を追加する。
9. OBJ loader と Lit Object `No IBL` を移植する。
10. HDRI environment loader を実装する。まず Radiance RGBE `.hdr` を `Float32Array` に展開し、equirectangular -> cubemap 変換、luminance/solid-angle 重み付き CDF、IBL progressive accumulation を移植する。
11. 元同梱 `.penv` probe は build-time converter で Web 用 cubemap/probability texture に変換し、比較対象 exe と同じ environment でスクリーンショット比較できるようにする。任意 `.penv` のブラウザ内 decode/WASM は必要になった時点で別工程にする。
12. `.bparam` save/load と local file workflow を実装する。
13. 元アプリとの比較検証を行う。同じ BRDF、同じ parameter、同じ入射角、同じ environment でスクリーンショット比較を取る。

## 検証観点

- `lambert.brdf`, `disney.brdf`, representative microfacet BRDF が全ビューで compile/render できる。
- parameter 変更が全ビューへ即時反映される。
- 3D Plot の形状、log plot、`N.L` 乗算が元アプリと一致する。
- Polar/Cartesian の曲線位置、線幅、pan/zoom/reset が一致する。
- solo と solo RGB channels の挙動が一致する。
- Lit Sphere の入射方向 drag と double theta が一致する。
- MERL measured BRDF の index mapping と RGB scale が一致する。
- IBL の `No IBL`, `IBL: No IS`, `IBL: IBL IS` の progressive accumulation が一致する。
- 通常 HDRI 入力で cubemap 変換、輝度/面積重み付き CDF、露出/gamma が安定して動く。
- 変換済み `.penv` 由来 environment で、比較対象 exe と IBL の方向・明るさ・蓄積挙動を比較できる。
- GitHub Pages のサブパス配信で asset URL が壊れない。

## 主要な未確定点

- 通常 HDRI の初期対応を `.hdr` のみにするか、初期から `.exr` も入れるか。実装リスクは `.hdr` の方が低い。
- 同梱 environment の配布形式を raw float binary、half-float binary、KTX2 のどれにするか。初期はデバッグしやすい raw/half-float binary が妥当。
- 任意 `.penv` のブラウザ内 decode を実装するか。現方針では必須ではなく、元同梱 probe は build-time 変換で対応する。
- 異方性 measured `.dat` はデータ量が大きいため、実際の公開アセットとして何を同梱するか。
- 元 `BRDFImageSlice::loadImage` が TIFF 未実装なので、Web 版で「元コード同等」を優先するか、実用上の TIFF reader を追加するか。
- IBL 境界差をどの程度まで許容するか。WebGL2 の seamless cube map sampling があっても、face 変換、mipmap、CDF の面積重みがずれると元アプリとの差になる。
