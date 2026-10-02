# 疑似 SSS（Lit Object の表面下散乱）

Last updated: 2026-10-01

**独自実装・近似**。Lit Object に、拡散光だけを画面上でぼかす表面下散乱（SSS）を足す機能です。特定のエンジンやゲームの実装そのものではありません。

- 既定はオン（Lit Object の `SSS`）。ただし処理されるのは、対応する `.brdf` を表示しているときだけ
- 対応する `.brdf`（下の「`.brdf` 側の約束」のフック関数を持つもの）でだけ使える。今は `callisto_brdf.brdf` と派生プリセット 5 本
- プロット、Image Slice、Lit Sphere、`evaluate()` には入らない（1 点の BRDF の値は変わらない）

この文書は、使い方、仕組み、別の `.brdf` への足し方、実装の場所、検証をまとめたものです。あとから手を入れる人（AI を含む）は、まず「実装の場所」と「別の `.brdf` に足す手順」を読んでください。

## 使い方

1. 対応する `.brdf` を読み込む（例 `callisto_brdf.brdf`）
2. Lit Object の `SSS` にチェックが入っていることを確かめる（既定で入っている。比べるときはここで切り替える）
3. `Size (cm)` に、モデルの最大の辺の実寸を入れる。散乱の距離は cm で決まるので、モデルが大きいほど、画面上の広がりは小さくなる
4. 左のパネルの `sss_` で始まるパラメータで調整する

| 操作部品・キー | 内容 |
| --- | --- |
| `SSS`（`litObject.sss`、`data-testid="ctl-sss"`） | オン・オフ。既定はオン。非対応の `.brdf` では灰色になり、オンでも通常の描画になる |
| `Size (cm)`（`litObject.sizeCm`、`ctl-size-cm`） | モデルの最大の辺の実寸（cm）。モデルを読み込むと、そのモデルの既定値に戻る。`dm` は OBJ が cm 単位なので 30.17、ほかは 20 |
| `sss_strength` | 散乱の強さ。散乱の距離に掛かる（0 で散乱なし） |
| `sss_scatter_radius` | 散乱が届く距離（cm） |
| `sss_falloff_r/g/b` | 色ごとの広がり（1 で最大。小さいほど狭い） |
| `sss_subsurface_r/g/b` | ぼかした拡散光を混ぜる割合（0 でぼかさない） |

```bat
rem 頭部モデルを、SSS あり・遮蔽のレイトレースありで撮る
capture.bat --brdf callisto_brdf.brdf --opt litObject.object=dm.obj --opt litObject.occlusion=ray --view litObject --frames 128 --out head_sss.png

rem 球の直径を 3 cm として、平行光で撮る
capture.bat --brdf callisto_brdf.brdf --light 90,0 --opt litObject.ibl=false --opt plot.nDotL=true --opt litObject.sizeCm=3 --view litObject --out sphere_sss.png
```

### 見え方の目安

散乱の距離は実寸で決まります。肌のプリセットは 0.5〜0.6 cm で、赤でも標準偏差は約 1.2 mm です。

- 効くのは mm 単位の陰影: ノーマルマップの細かい凹凸、鼻・唇・耳・まぶたの際、影の縁。赤だけが広がるので、境目が赤くにじむ
- 頭の大きさ（直径 20 cm）の球の明暗境界は、ほとんど変わらない（拡散の値で 0.1% 程度）。球で確かめるときは `Size (cm)` を 3 などに小さくする
- 既定の表示では 1 画素が約 0.7 mm（頭部モデル、高さ 512 画素）なので、寄るか、`supersample` を上げないと広がりが解像しない
- 平行光（`IBL` オフ）には影が無い。影の縁のにじみを見るなら `IBL` オン + `Occlusion` = `Ray`

## 仕組み

UE4 系の Subsurface Profile で使われる「画面空間の Separable SSS」（Jimenez）と同じ考え方です。ライティングの結果を「拡散光（アルベドを掛ける前）」「スペキュラ」「アルベド」に分けて持ち、拡散光だけをぼかして、最後に合成します。

```text
1. シーン描画（3 枚の描画先に同時に書く）
     出力 0: スペキュラ RGB（ぼかさない。背景もここ）、A = 被覆
     出力 1: 拡散光 RGB（アルベドを掛ける前）、A = 視線方向の深度（面が無ければ 0）
     出力 2: アルベド RGB
2. IBL のとき: フレームをまたいだ平均（3 枚とも）
3. ぼかし 水平 → 4. ぼかし 垂直（出力 1 だけ）
5. 合成: mix(拡散, ぼかした拡散, sss_subsurface) × アルベド + スペキュラ
6. 露出・トーンマップ・HDR（通常の経路と共通）
```

- 3〜5 は表示のたびに 1 回だけ行う。ぼかしは線形なので、モンテカルロの平均を取った後に掛ければよい
- アルベドは散乱の後に掛ける。`base_color` にテクスチャを貼っても、模様はぼけない

### カーネル

- 5 つのガウスの和（重み, 分散）= (0.100, 0.0484)、(0.118, 0.187)、(0.113, 0.567)、(0.358, 1.99)、(0.078, 7.41)。肌の拡散プロファイル（d'Eon & Luebke、GPU Gems 3）から、最も細いガウスを「散乱しない光」として外したもの
- 色ごとに距離を `r ÷ (0.001 + sss_falloff)` と縮める（`sss_falloff` は 0.009 以上に切り上げ）
- 1 次元の 13 タップ（中心 + 片側 12）。位置は 0〜3 を 2 乗で詰めた並び、重みは「区間の幅 × プロファイル」で、色ごとに合計 1 に正規化する
- 位置 3 が `sss_scatter_radius × sss_strength`（cm）に当たる
- これを水平・垂直の 2 回掛ける。2 次元の実効カーネルは K(x)·K(y) で、放射対称ではない（Separable 方式の性質）

### ぼかしの 1 パス

画素ごとに次を行います（`web/src/gl/sss.ts` の `BLUR_FRAG`）。

1. 中心の深度 `z` から、1 cm が何画素かを求める: `0.5 × 高さ × proj[1][1] ÷ (cm / シーン単位) ÷ z`。透視投影なので、奥ほど小さくなる
2. 隣り合う 2 タップの間を `subSteps` 段（静止画は 8、操作中と積算中は 4）に分け、位置と重みを線形に補間して読む。13 個の固定タップではなく、連続したカーネルになる
3. 読む画素は最も近い 1 点（補間なし）。面の無い画素（深度 0）は飛ばす
4. 重みに `exp(−0.01 × 深度差²)`（深度差は cm）を掛ける。奥行きの離れた面どうしが混ざらない
5. 重みの合計で割る

### 大きさ

メッシュは読み込み時に、最大の辺が 2 シーン単位になるよう正規化されます（内蔵の球は半径 1）。`Size (cm)` はこの「2」が何 cm かを表し、`cm / シーン単位 = Size ÷ 2` です。OBJ の先頭に「centimeters as units」のコメントがあれば、元の寸法を既定値にします（`IndexedMesh.sourceSizeCm`）。

## `.brdf` 側の約束

`.brdf` の `::begin shader` の中に、任意の関数を足します（このプロジェクトの拡張。元の BRDF Explorer では使われない関数が増えるだけなので、読み込みには影響しません）。

```glsl
// 必須: 拡散の項。アルベドを掛ける前、N·L も掛ける前（BRDF() と同じ扱い）
vec3 BRDF_sss_diffuse(vec3 L, vec3 V, vec3 N, vec3 X, vec3 Y);

// 任意: 散乱の後に掛けるアルベド（リニア）。無ければ 1 として扱う
vec3 BRDF_sss_albedo();
```

約束は 1 つです。

```text
BRDF() = BRDF_sss_diffuse() × BRDF_sss_albedo() + スペキュラ
```

ビューアは、スペキュラを `max(BRDF() − 拡散 × アルベド, 0)` で求めます。したがって `BRDF()` の拡散が、フックの「拡散 × アルベド」と同じ式になっている必要があります（共通の関数から両方を作るのが確実）。`BRDF_sss_albedo` を書かない場合は、`BRDF_sss_diffuse` にアルベドを含めます（模様もぼける）。

パラメータは、次の名前の float を `::begin parameters` に書きます。どれも任意で、無いものは既定値（UE の既定の Subsurface Profile の値）になります。

| 名前 | 既定値 | 内容 |
| --- | --- | --- |
| `sss_strength` | 1 | 散乱の強さ（距離の倍率） |
| `sss_scatter_radius` | 1.2 | 届く距離（cm） |
| `sss_falloff_r` / `_g` / `_b` | 1 / 0.37 / 0.3 | 色ごとの広がり |
| `sss_subsurface_r` / `_g` / `_b` | 0.48 / 0.41 / 0.28 | ぼかした光を混ぜる割合 |

- color ではなく float 3 本にしているのは、リニアの値をそのまま持つため（color は sRGB の値として扱われる）
- パラメータなので、スライダー、ツールチップ、状態 JSON、共有 URL、`--set` にそのまま載る
- シェーダの中で使わない uniform になるが、問題ない（ビューアが名前で値を読む）

### `sss_strength` という名前について

Callisto の出荷データでは、散乱の強さは画素ごとの Opacity（テクスチャ）から来ており、Callisto 項の効き `m`（`advanced_strength`）も同じ Opacity から決まります（`m = saturate(10 × (Opacity − 0.1))`、散乱の強さ = `m × Opacity`）。ここでは 2 つを独立したスライダーにしています。既存のパラメータ名（`advanced_strength`）と、それを使う状態・URL・検証スクリプトを変えないためです。ゲームと同じ連動にしたいときは、Opacity 0.2 以上なら `advanced_strength = 1`、`sss_strength = Opacity` とします。

## 別の `.brdf` に足す手順

1. 拡散の項を、アルベド抜きで返す関数にまとめる
2. `BRDF_sss_diffuse`（と、必要なら `BRDF_sss_albedo`）を足し、`BRDF()` の拡散を同じ関数から作る
3. `sss_*` のパラメータを足す（コメントは日本語 / 英語。CLAUDE.md の決まり）
4. 派生ファイルがあれば作り直す（Callisto は `python scripts/gen_callisto_presets.py`）
5. `python scripts/verify_sss.py` を実行する。フックを持つ `.brdf` は自動で対象になり、「スペキュラを 0 にすると `BRDF = 拡散 × アルベド`」を確かめる。スペキュラを 0 にするパラメータが `specular` でない場合は、スクリプトの該当箇所を合わせる
6. `.brdf` の先頭のコメントと、検証文書に「疑似 SSS は独自実装・近似」と書く

最小の例（Lambert）:

```glsl
vec3 BRDF_sss_albedo() { return mon2lin(base_color); }
vec3 BRDF_sss_diffuse(vec3 L, vec3 V, vec3 N, vec3 X, vec3 Y) { return vec3(1.0 / 3.14159265); }
vec3 BRDF(vec3 L, vec3 V, vec3 N, vec3 X, vec3 Y) {
    return BRDF_sss_albedo() * BRDF_sss_diffuse(L, V, N, X, Y);
}
```

## 実装の場所

機能に固有のものは `web/src/gl/sss.ts` に集めてあります。通常の経路（SSS オフ、または非対応の `.brdf`）は、追加前と同じシェーダ・同じ描画先を使います。

| ファイル | 役割 |
| --- | --- |
| `web/src/gl/sss.ts` | フックの検出（`sssSupport`）、シェーダの定義（`sssDefines`）、パラメータの読み取り（`sssParamsOf`、`SSS_DEFAULTS`）、カーネル（`separableKernel`）、描画先とパス（`SssPipeline`: `beginScene` / `accumulate` / `resolve`）、ぼかしと合成の GLSL |
| `web/public/shaderTemplates/iblObject.frag` | `#ifdef BRDF_SSS` の中だけが追加分。出力を 3 つにし、拡散とスペキュラを分けて書く |
| `web/src/brdf/shader-builder.ts`、`web/src/gl/brdf-program.ts` | 雛形の `::INSERT_DEFINES_HERE::` に定義を差し込む。プログラムのキャッシュは定義ごとに別 |
| `web/src/views/lit-object.ts` | 使うかどうかの判断（`activeSss`）、シーンを `SssPipeline` の描画先へ描く分岐（`drawScene` の `sss` 引数）、積算と表示の分岐、状態（`sss`、`sizeCm`）、操作部品 |
| `web/src/gl/mesh.ts` | OBJ の元の寸法（`sourceSizeCm`） |
| `web/src/api/evaluate.ts`、`web/public/shaderTemplates/evaluate.frag` | `evaluate` の `component`（`'sssDiffuse'` / `'sssAlbedo'`）。フックの値を数値で取り出す（検証用） |
| `sample/brdf/callisto_brdf.brdf`、`scripts/gen_callisto_presets.py` | フックと `sss_*` パラメータ、プリセットの値 |
| `scripts/verify_sss.py` | 検証（下） |

オン・オフと取り外し:

- 実行時: `litObject.sss`（既定 `true`）。オフ、または非対応の `.brdf` なら `SssPipeline` は作られない
- `.brdf` 単位: フック関数を消せば、その `.brdf` は非対応になる
- 機能ごと外す: `lit-object.ts` の `activeSss()` が常に `null` を返すようにすれば、残りのコードは通らない

前提と制限:

- 浮動小数の描画先（`EXT_color_buffer_float`）が要る。無い環境では `SSS` が灰色になる
- 描画先が 3 枚、`BRDF()` とフックの 2 回評価になるので、オンの間は重くなる
- ぼかしは画面に見えている面しか使えない。輪郭の裏側や、隠れた面からの光は入らない
- 透過（裏から抜ける光）は含まない
- 材質は 1 つ（表示中の先頭の BRDF）。材質の境界の処理は無い

## 検証

`scripts/verify_sss.py` が、ビューアの動作をそのまま（`capture.mjs --batch` 経由で）確かめます。

```bat
python scripts/verify_sss.py
```

1. **フックの約束**: フックを持つ `.brdf` すべてで、スペキュラを 0 にしたとき `BRDF = BRDF_sss_diffuse × BRDF_sss_albedo` になること（`evaluate`、float32）
2. **フィルタ**: 横から平行光を当てた球を SSS オンで撮り、画像の中央の行を、同じアルゴリズムの Python 実装（カーネル、透視投影、深度の重み、分割、合成）と比べる。散乱前の拡散光は、フック関数の値（`evaluate`）を使う。画像は 8bit なので、露出を変えて 2 回撮る（全体用と、明暗境界用）

2026-10-01 の結果（RTX 5090、ANGLE D3D11）:

| 確認 | 条件 | 結果 |
| --- | --- | --- |
| フックの約束 | Callisto の 6 本 × 45 方向 | 最大誤差 3×10⁻⁸ |
| フィルタ | 肌（直径 3 cm / 20 cm、強さ 0.5、Callisto 項なし）、歯（6 cm）、囚人服（40 cm）、フックだけの Lambert（既定値、6 cm） | 全体: 誤差 0.0010〜0.0014（8bit の刻み 0.0020 以内）。明暗境界: 誤差 0.00006〜0.00008（刻み 0.00012 以内） |
| SSS オフ | 同じ 7 条件 | 散乱前の拡散と一致（刻み以内） |

出力は `verify_out/sss/`（git に入れない）。参照実装は独自のもので、「この文書のとおりに動いていること」を確かめるものです。エンジンやゲームとの一致を示すものではありません。

## Callisto のプリセットの値

| プリセット | `sss_scatter_radius` | `sss_falloff` | `sss_subsurface` |
| --- | --- | --- | --- |
| 顔（`callisto_brdf`） | 0.5 | (1, 0.25, 0.05) | (1, 1, 1) |
| 汎用の肌 | 0.6 | (1, 0.25, 0.05) | (1, 1, 1) |
| 眼 | 0.5 | (1, 0.65, 0.15) | (1, 1, 1) |
| 歯 | 1.5 | (0.8, 0.5, 0.25) | (1, 1, 1) |
| 囚人服 | 10 | (1, 0.35, 0) | (0.1, 0.1, 0.1) |

元のプロファイルの ScatterRadius、FalloffColor、SubsurfaceColor です。汎用の肌はファイルを同梱していないので、`callisto_brdf` のパラメータを変えて使います。囚人服は距離が長いかわりに、混ざる割合が 10% です。
