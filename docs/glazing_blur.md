# Specular Glazing Blur（Lit Object、試験実装）

Last updated: 2026-10-01

**試験実装・独自実装・近似**。出荷版のレンダラの動作を再構成したもので、元の実装そのものではありません。効果を確かめるために入れた機能で、効果がはっきりしなければ削除します。

- 既定はオン（Lit Object の `Glazing`）。ただし処理されるのは、下の条件を満たすときだけ
- 効くのは、**IBL かつ `Occlusion` が `Ray`** で、対応する `.brdf` を表示しているときだけ。それ以外は通常の描画のまま
- 対応する `.brdf`: float パラメータ `glazing_blur_radius` と、疑似 SSS のフック `BRDF_sss_diffuse` を持つもの（ほかの `glazing_*` は任意。無ければ元の動作の値を使う）。今は `callisto_brdf.brdf` と派生プリセット
- プロット、Image Slice、Lit Sphere、`evaluate()` には入らない（`BRDF()` は変えていない）

## 何をするか

光がかすめる明暗境界の帯で、ライティングの 1 サンプルごとに、近くの画素を 1 つ選び、次の 2 つを借りる。選び方をサンプルごとに変え、積算で平均する。

- スペキュラ用の法線（法線マップ込み）。スペキュラの N·L もこの法線で計算する
- 影のレイの出発点（拡散とスペキュラの両方の影が、借りた位置のものになる）

拡散の法線、ベースカラー、ラフネスは自分の画素のまま。

| 項目 | 内容 |
| --- | --- |
| 距離 | `glazing_blur_radius`（cm）× `advanced_strength` × `(1 − N·L)⁴`。N は自分の法線。光の方を向いた面ではほぼ 0 |
| 選び方 | 単位円の中の 512 個の点から 1 つ。半径の割合は `(u / 512)³`（中心に集まる。中央値は最大の 1/8）、角度は `u` のビット反転 |
| 画面上の大きさ | cm を `Size (cm)` とカメラの投影で画素に直す |
| 使う条件 | 借りる画素に面があり、ビュー空間の深度の差が 0.5 cm 以内。満たさなければ自分の値のまま |
| 影の判定 | 影を取る位置（借りた位置）の法線が光と反対を向いていれば、影の中として扱う。そうでなければ、その位置から影のレイを飛ばす |

元の処理は 1 灯 1 画素につき 1 回で、フレームごとの乱数と TAA で平均する。ここでは IBL の 1 サンプルを 1 灯と見なし、乱数は画素とサンプル番号のハッシュで決める。

## 使い方

1. `callisto_brdf.brdf`（または `callisto_skin_*`）を読み込む
2. Lit Object で `IBL` をオン、`Occlusion` を `Ray` にする
3. `Glazing` にチェックが入っていることを確かめる（既定で入っている）。オン・オフして比べる。左のパネルの `glazing_blur_radius` を大きくすると、効果を確かめやすい（顔の値は 0.25 cm）

```bat
capture.bat --brdf callisto_brdf.brdf --opt litObject.object=dm.obj --opt litObject.occlusion=ray --view litObject --frames 128 --out head_glazing.png
```

| 操作部品・キー | 内容 |
| --- | --- |
| `Glazing`（`litObject.glazing`、`data-testid="ctl-glazing"`） | オン・オフ。既定はオン。非対応の `.brdf` では灰色になり、オンでも通常の描画になる |
| `glazing_blur_radius` | 借りる画素までの最大の距離（cm）。0 で無効 |
| `glazing_graze_power` | 試験用。距離に掛ける `(1 − N·L)` の指数。元の動作は 4。0 にすると、光の方を向いた面でも同じ距離で借りる（落ち影の境界もぼける） |
| `glazing_radius_power` | 試験用。借りる画素の散らし方（距離の割合 = 乱数^指数）。元の動作は 3。1 で半径方向に一様、0.5 で円内に一様 |
| `glazing_depth_tolerance` | 試験用。借りる画素との奥行きの差の上限（cm）。元の動作は 0.5 |
| `glazing_borrow_normal` / `glazing_borrow_shadow` | 試験用。法線だけ、影だけを借りて、どちらが効いているかを見分ける。元の動作は両方オン |
| `Size (cm)`（`litObject.sizeCm`） | モデルの最大の辺の実寸（cm）。疑似 SSS と共用 |

## 実装の場所

| ファイル | 役割 |
| --- | --- |
| `web/src/gl/glazing.ts` | 対応の判定（`glazingSupport`）、定義の差し込み（`glazingDefines`）、G バッファ（`GlazingGBuffer`: 法線と深度、ワールド位置、幾何法線） |
| `web/public/shaderTemplates/iblObject.frag` | `GLAZING_GBUFFER`（前段パス: 法線・深度・位置だけを書く）と `BRDF_GLAZING`（IBL のサンプルごとの処理）。定義が無ければ今までのシェーダと同じ |
| `web/src/views/lit-object.ts` | `glazingActive()`（使う条件）、`prepareGlazing()`（積算のやり直しのたびに G バッファを描く）、チェックボックスと状態 |

擬似 SSS と併用できる。拡散光（自分の法線）は SSS の拡散の出力へ、スペキュラ（借りた法線）はスペキュラの出力へ書く。

## 削除するとき

`web/src/gl/glazing.ts` と、`iblObject.frag` の `BRDF_GLAZING` / `GLAZING_GBUFFER` の部分、`lit-object.ts` の `glazing` を含む部分、`.brdf` の `glazing_blur_radius`、`scripts/gen_callisto_presets.py` の同じキー、この文書を消す。
