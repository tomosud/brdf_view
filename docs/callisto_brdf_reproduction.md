# callisto_brdf reproduction status

Last updated: 2026-10-01

対象: `sample/brdf/callisto_brdf.brdf`

## 位置づけ

**独自実装・近似**。The Callisto Protocol（SIGGRAPH 2023 Advances, Jimenez & Petersen）の
"Callisto BRDF" を、出荷データの SubsurfaceProfile の値と、ディファードライトの GPU キャプチャ
（逆アセンブル）から再構成した `.brdf` です。元の実装そのものではありません。再構成した式とは数値で一致することを確かめました（下の「数値の検証」）が、ゲームの画面との一致は検証していません。
アプリ内では `callisto_brdf [custom implementation / 独自実装]` と表示します。

元の Callisto BRDF は UE4 の SubsurfaceProfile（SSP）の拡張です。パラメータは SSP アセットにあり、
実行時は SSP テクスチャ経由でディファードライトに渡されます。この `.brdf` では、それらをスライダーで直接持ちます。

## 実装の対応

| 項目 | 元実装（キャプチャから読んだ式） | この実装 | 判定 |
|---|---|---|---|
| 拡散の基礎 | Lambert（`DiffuseColor/π`） | 同じ | そのまま |
| Diffuse Fresnel | `lerp(DiffuseFresnelPeak, 1, sqrt(L·H))` | 同じ | そのまま |
| Anti-Specular Peak | `lerp(Peak.rgb, 1, pow(N_d·H, Falloff))` | 同じ（`N_d = N`） | そのまま |
| Diffuse Smooth Terminator | `smoothstep(0,1,saturate(N_d·L / DST))` | 同じ | そのまま |
| デュアル GGX | D_GGX と Vis_SmithJointApprox をローブごとに計算し、`LobeMix` で混合 | 同じ | そのまま |
| ローブのラフネス | BasePass が `saturate(R × lerp(1, 平均, m))` を GBuffer に書き（平均 = `lerp(Roughness0, Roughness1, LobeMix)`）、ライトが `× Roughness0/平均`（1 も同様）で戻す。下限 0.02、`lerp(R', r, m)` | 同じ（2026-10-01 に修正。以前は BasePass 側の倍率が無く、`m` が中間のときに最大 56% ずれていた） | そのまま |
| 第 2 ローブのティント | F0 × DualSpecularTint で別に Fresnel を計算 | 同じ | そのまま |
| Specular Fresnel Falloff | Schlick の指数を `5 × Falloff` に | 同じ（F90 は UE の `saturate(50·F0.g)`） | そのまま |
| Specular Smooth Terminator | RGB 別 `smoothstep(saturate(N·L / w))`、`w = lerp(mean(SST·Tint), SST·Tint, N·V)` | 同じ | そのまま |
| Callisto 項の効き `m` | GBuffer の 4bit 値（画素ごと） | `advanced_strength` スライダー（0 で標準 SSP と同じ） | 代替 |
| F0 | GBuffer の Specular（0.08·Specular） | `specular` パラメータ | そのまま |
| GGX の面光源正規化 | UE の Sphere/Rect ライト向けエネルギー正規化 | 点光源の D_GGX | 代替 |
| Dual Normal | 拡散とスペキュラに別の法線（shading model 13） | 法線 1 本 | 省略 |
| Specular Glazing Blur | ライトの冒頭で、近傍画素のスペキュラ法線と影を確率的に借りる | `BRDF()` には無い。Lit Object の `Glazing`（既定はオン、IBL かつ Occlusion が Ray のときだけ）が再現する。距離は `glazing_blur_radius`。[glazing_blur.md](glazing_blur.md) | 代替（独自実装・近似。Lit Object のみ） |
| SSS（散乱） | 画面空間の Separable SSS（ガウスの和。Burley ではない）。拡散光だけを、プロファイルの ScatterRadius・FalloffColor・SubsurfaceColor でぼかす | `BRDF()` には無い。Lit Object の疑似 SSS（`SSS`、既定はオン）が同じ考え方でぼかす。値は `sss_*` パラメータ。[pseudo_sss.md](pseudo_sss.md) | 代替（独自実装・近似。Lit Object のみ） |
| 透過・境界の色にじみ | 裏から抜ける光、別のプロファイルとの境界でのにじみ | なし | 省略 |
| SSP テクスチャ・GBuffer の符号化 | 列 3.zw / 6〜8、÷10 格納、プロファイル ID | なし（パラメータを直接持つ） | 省略 |
| Eye モデル | 虹彩法線・角膜（Callisto 項は Eye にも入る） | なし | 省略 |
| Realis | 撮影との残差補正（別機能） | なし | 省略 |

## パラメータ

既定値は Jacob の顔（`SP_Jacob_Head`）の出荷値です。`base_color` / `specular` / `roughness` は
テクスチャから来る値なので、代表値を置いています。

| パラメータ | 元のフィールド | 中立値（効果なし） | Jacob 顔 | 汎用肌 | 眼 | 歯 | 囚人服 |
|---|---|---|---|---|---|---|---|
| `roughness0_scale` | Roughness0 | – | 0.55 | 0.44 | 1.1 | （既定） | 1 |
| `roughness1_scale` | Roughness1 | – | 1.0 | 1.0 | 2.0 | 2.0 | 1 |
| `lobe_mix` | LobeMix | 0 | 0.9 | 0.95 | 0.175 | 0.7 | 1 |
| `dual_spec_tint_rgb` | DualSpecularTint | 1 | (1.1,0.95,1) | (0.464,1,0.91) | (1,1.4,0.8) | 1 | (1,0.8,0.1) |
| `spec_fresnel_falloff` | SpecularFresnelFalloff | 1 | 0.65 | 0.55 | 1 | 1 | 0.75 |
| `spec_smooth_terminator` | SpecularSmoothTerminator | 0 | 0.3 | 0.3 | 0 | 0 | 0.5 |
| `spec_term_tint_rgb` | SpecularSmoothTerminatorTint | 1 | (1,0.7,0.85) | 1 | – | – | (0,0.5,1) |
| `diffuse_smooth_terminator` | DiffuseSmoothTerminator | 0 | 0.15 | 0.15 | 0 | 0 | 0.5 |
| `diffuse_fresnel_peak` | DiffuseFresnelPeak | 1 | 1 | 1 | 6 | 4 | 5 |
| `anti_spec_peak_rgb` | DiffuseAntiSpecularPeak | 1 | (0.5,1,0) | (0,1,0.5) | 1 | (1.5,1.5,1) | (0.5,0.5,0.5) |
| `anti_spec_peak_falloff` | DiffuseAntiSpecularPeakFalloff | 1 | 0.125 | 0.125 | 1 | 4 | 0.5 |

疑似 SSS 用のパラメータ（`BRDF()` の値には影響しない。Lit Object の `SSS` がオンのときだけ使う）:

| パラメータ | 元のフィールド | Jacob 顔 | 汎用肌 | 眼 | 歯 | 囚人服 |
|---|---|---|---|---|---|---|
| `sss_scatter_radius` | ScatterRadius（cm） | 0.5 | 0.6 | 0.5 | 1.5 | 10 |
| `sss_falloff_rgb` | FalloffColor | (1,0.25,0.05) | (1,0.25,0.05) | (1,0.65,0.15) | (0.8,0.5,0.25) | (1,0.35,0) |
| `sss_subsurface_rgb` | SubsurfaceColor | 1 | 1 | 1 | 1 | (0.1,0.1,0.1) |
| `sss_strength` | 画素ごとの `m × Opacity`（テクスチャ） | 1（代表値） | 1 | 1 | 1 | 1 |

- 元のプロファイルにある Burley 用の値（SurfaceAlbedo、MeanFreePath）は、元の実装の散乱では使われていないので、持たせていません
- フック関数 `BRDF_sss_diffuse` / `BRDF_sss_albedo` と疑似 SSS の仕組み・検証は [pseudo_sss.md](pseudo_sss.md)
- `*_r/_g/_b` のティントは、ゲームデータの線形値をそのまま使います（sRGB → リニア変換はかけない）。`base_color` だけは他のサンプルと同じく `mon2lin()`（正確な sRGB 曲線）でリニアにします
- 1 を超えるティント（DualSpecularTint 1.1、歯の AntiSpecularPeak 1.5 など）があるので、color ではなく float 3 本にしています

## 派生プリセット

素材ごとの初期値を入れた派生ファイルです。シェーダは `callisto_brdf.brdf` と同一で、
`python scripts/gen_callisto_presets.py` で生成します（手で編集しない）。
`callisto_brdf.brdf` のシェーダやパラメータを変えたら、再生成してください。
ビューアにプリセット機能ができたら、これらは `callisto_brdf.brdf` のプリセットに置き換える予定です。

| ファイル | 元のプロファイル | 備考 |
|---|---|---|
| `callisto_skin_jacob.brdf` | `SP_Jacob_Head` | `callisto_brdf.brdf` の初期値と同じ |
| `callisto_skin_generic.brdf` | `SSP_HumanSkin` | NPC 用の汎用肌 |
| `callisto_eye.brdf` | `SP_*_Eye_Main` | Callisto 項のみ。虹彩法線・角膜（Eye モデル）は含まない |
| `callisto_teeth.brdf` | `SP_Jacob_Teeth` | Roughness0/1・LobeMix は SSP テクスチャの値（0.75 / 2.0 / 0.7） |
| `callisto_cloth_prisoner.brdf` | `SP_Player_Jacob_Cloth` | 囚人服 |

`base_color` / `specular` / `roughness` はゲームではテクスチャから来るので、プリセットでは代表値です。

## 確認済みの点

- WebGL2（GLSL ES 3.00）でシェーダがコンパイルできることを確認（headless Chromium / SwiftShader）
- 再構成した式との数値一致（下の「数値の検証」）。疑似 SSS のフックを足した後（2026-10-01）も、同じ結果（最大相対誤差 1.0e-4）
- 疑似 SSS: フックの約束と、フィルタの参照実装との一致（`scripts/verify_sss.py`。結果は [pseudo_sss.md](pseudo_sss.md)）
- ビューア上での見た目の確認は未実施（ユーザー確認）

## 数値の検証（2026-10-01）

`scripts/verify_callisto_brdf.py` が、再構成した出荷版の式（skin_mat_lean の `docs/pseudocode_callisto_brdf_realis.md` 1 章）を
Python に写した参照実装と、brdf_view の `evaluate`（GPU、float32、露出・ガンマ前）を比べます。

```bat
python scripts/verify_callisto_brdf.py
```

- 条件: `.brdf` 6 本（本体と派生 5 本）× `m` = 0, 0.25, 0.5, 0.75, 1、本体はさらにラフネス 0.9 / 0.02、ターミネーター 0、
  ピークの強い値の 4 組 × `m` = 0.5, 1。光の θ = 0〜150°（12 段）× φ 5 方向、視点の θ = 0〜89°（5 段）。計 38 条件 × 300 サンプル × RGB
- 比べる量: BRDF × N·L（出荷版のライトは N·L 込みの値を返すため）
- 結果: 全条件で最大相対誤差 1.0e-4（許容 1e-3）。ラフネス 0.02 の鏡面方向（N·H ≈ 1）のサンプル（2 条件 × 8）だけは、
  D_GGX の float32 の桁落ちで値が大きく揺れるので除外した（ゲームの GPU でも同じ計算になる）
- 出力は `verify_out/`（git に入れない）

| # | 項目 | 結果 |
| --- | --- | --- |
| 1 | 効き `m` | 一致。全項を `m` で補間し、`LobeMix` は補間しない。4bit の量子化（ディザ付き）は再現しない（`advanced_strength` は連続値）。BasePass は量子化前の Opacity から `m` を作る点も同様に省略 |
| 2 | ローブのラフネス | **修正して一致**。`m` = 1 で `R × Roughness0`（`R × 平均 ≤ 1` のとき）、`m` = 0 で `R` |
| 3 | フレネル | 一致。F90 は `saturate(50·F0.g)`、指数 `5 × Falloff` |
| 4 | 第 2 ローブ | 一致。ティントは F0 側（F90 も `F0·Tint` の緑から） |
| 5 | スペキュラのターミネーター | 一致。幅 0 で係数 1 |
| 6 | 拡散のターミネーター | 一致。幅 0 で係数 1 |
| 7 | Anti-Specular Peak | 一致（Falloff 0.125 と 4 で確認） |
| 8 | 拡散フレネル | 一致。L·H は 0〜1 |
| 9 | 面光源の正規化 | 差として残す（代替）。点光源（半径 0）なら出荷版の正規化係数は 1 |
| 10 | 色空間 | 一致。`base_color` だけ正確な sRGB 曲線でリニア化、ティントは線形のまま |
| 11 | プリセットの値 | 一致。`subsurface_profiles.csv` の空欄は UE の既定値（Roughness0 0.75、ティント・ピーク・Falloff 1、ターミネーター 0） |
| 12 | 既定値 | `m` = 0 では UE 標準の SSP（単一の GGX）と一致。Callisto の項を中立値にして `m` = 1 にしたものは、出荷版の標準 SSP（シェーディングモデル 5）と同じ式。ただし **UE 5.8 標準の SSP とは 2 点違う**: (a) UE 5.8 は Vis を平均ラフネスで 1 回だけ計算する（出荷版はローブごとに 2 回。命令列で確認）。Jacob の値で最大 27%（グレージング）、(b) UE 5.8 は BasePass の倍率が無く、ローブのラフネスは `R × lerp(1, Roughness0, m)`、下限 0.02 は第 1 ローブだけ。`m` = 1 では (b) の差は無い |
