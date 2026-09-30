# callisto_brdf reproduction status

Last updated: 2026-09-30

対象: `sample/brdf/callisto_brdf.brdf`

## 位置づけ

**独自実装・近似**。The Callisto Protocol（SIGGRAPH 2023 Advances, Jimenez & Petersen）の
"Callisto BRDF" を、出荷データの SubsurfaceProfile の値と、ディファードライトの GPU キャプチャ
（逆アセンブル）から再構成した `.brdf` です。元の実装そのものではなく、ゲームの画面との一致も検証していません。
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
| デュアル GGX | UE 標準の SSP デュアルスペキュラ。ローブのラフネス = Roughness × Roughness0/1、`LobeMix` で混合 | 同じ（D_GGX, Vis_SmithJointApprox） | そのまま |
| 第 2 ローブのティント | F0 × DualSpecularTint で別に Fresnel を計算 | 同じ | そのまま |
| Specular Fresnel Falloff | Schlick の指数を `5 × Falloff` に | 同じ（F90 は UE の `saturate(50·F0.g)`） | そのまま |
| Specular Smooth Terminator | RGB 別 `smoothstep(saturate(N·L / w))`、`w = lerp(mean(SST·Tint), SST·Tint, N·V)` | 同じ | そのまま |
| Callisto 項の効き `m` | GBuffer の 4bit 値（画素ごと） | `advanced_strength` スライダー（0 で標準 SSP と同じ） | 代替 |
| F0 | GBuffer の Specular（0.08·Specular） | `specular` パラメータ | そのまま |
| GGX の面光源正規化 | UE の Sphere/Rect ライト向けエネルギー正規化 | 点光源の D_GGX | 代替 |
| Dual Normal | 拡散とスペキュラに別の法線（shading model 13） | 法線 1 本 | 省略 |
| Specular Glazing Blur | ライトの冒頭で、近傍画素のスペキュラ法線と影を確率的に借りる | なし（画面空間処理のため） | 省略 |
| SSS・透過 | Burley 散乱、境界の色にじみ、透過 | なし | 省略 |
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
- ビューア上での見た目の確認は未実施（ユーザー確認）
