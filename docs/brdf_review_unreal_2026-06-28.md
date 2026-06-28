# BRDF レビュー（UE ソース照合版）— Legacy Default Lit / Substrate

対象（**レビューのみ。コードは変更していない**）:

- [`sample/brdf/unreal_legacy_pbr.brdf`](../sample/brdf/unreal_legacy_pbr.brdf)
- [`sample/brdf/substrate.brdf`](../sample/brdf/substrate.brdf)

照合元: 実 UE シェーダ `C:\work\unreal\Shaders`（参照ガイド: [`docs/unreal_shader_related_files.md`](unreal_shader_related_files.md)）。
実ソースと関数単位で突き合わせた結果。**本ドキュメントは修正反映後の最新ファイルに合わせている。**

レビュー日: 2026-06-28（修正反映版）

---

## 0. 総評

| ファイル | 元ソースとの一致度 | 一言 |
|---|---|---|
| **unreal_legacy_pbr.brdf** | ★★★★★ 1:1 移植 | `DefaultLitBxDF` の直接照明 BxDF を定数レベルまで忠実移植。実用上の修正点なし。 |
| **substrate.brdf** | ★★★★★ 高忠実な局所近似 | Slab 直接項を実 Substrate 評価に沿って再現。Fresnel(F0/F90)・異方性・エネルギー保存・Haziness・Fuzz まで一致。 |

いずれも「ローカル BRDF 値」のみを返す（光減衰・NoL 乗算・影・area-light LTC・IBL・GBuffer 等は対象外）。

> ⚠️ ただし**両ファイルに共通の実バグ**あり: 異方性（`anisotropy != 0`）かつ低 roughness でハイライトが消えて真っ黒になる。原因は `dGGXAniso` の `max(s, EPS)`（EPS=1e-6）。詳細は下記「★ 共通不具合」節。式自体は正しく、エネルギーも保存している。

---

## 1. `unreal_legacy_pbr.brdf` — UE DefaultLit の忠実移植

### 1.1 関数単位の照合結果（すべて一致）

| .brdf の関数 | UE ソース | 一致 |
|---|---|---|
| `dGGX` | `D_GGX` [`BRDF.ush:311`] `a2/(PI*d*d)`, `d=(NoH*a2-NoH)*NoH+1` | ✅ 完全一致 |
| `dGGXAniso` | `D_GGXaniso` [`BRDF.ush:319`] `(1/PI)*a2*Square(a2/S)` 形 | ✅ 完全一致 |
| `visSmithJointApprox` | `Vis_SmithJointApprox` [`BRDF.ush:373`] | ✅ 完全一致 |
| `visSmithJointAniso` | `Vis_SmithJointAniso` [`BRDF.ush:390`] | ✅ 完全一致 |
| `anisotropicAlpha` | `GetAnisotropicRoughness(Alpha,…)` [`BRDF.ush:551`]、`Alpha=Roughness²`, `ax=max(Alpha*(1+A),0.001)` | ✅ 完全一致 |
| `computeF0` | `ComputeF0=lerp(0.08*Specular,BaseColor,Metallic)` [`ShadingCommon.ush:169`,`122`] | ✅ 完全一致 |
| `computeDiffuseAlbedo` | `ComputeDiffuseAlbedo=BaseColor-BaseColor*Metallic` [`ShadingCommon.ush:179`] | ✅ 完全一致 |
| `diffuseEON` | `Diffuse_EON` [`BRDF.ush:213`]（`0.189468`, `constant1_FON`, `g1=0.262048`, `Rho²` 補償） | ✅ 完全一致 |
| `diffuseGGXRough` | `Diffuse_GGX_Rough` v3 [`BRDF.ush:238/249`]、`Diffuse_EON(.., w*r*0.4,..)`, `VoL=2VoH²−1` | ✅ 完全一致 |
| `fresnelSchlickUE` | `F_Schlick(SpecularColor,VoH)` [`BRDF.ush:403`] `saturate(50*SpecularColor.g)*Fc+(1-Fc)*Spec` | ✅ 完全一致（**緑チャンネル `specularColor[1]` を使用**） |
| `ggxEnergyTerms` の `e`,`ef` | `GGXEnergyLookup` の `USE_ENERGY_CONSERVATION==2` 解析フィット [`ShadingEnergyConservation.ush:77-78`] | ✅ 完全一致（定数 `0.0266916/0.466495/2.36651/4.7703/0.0387332` まで） |
| `ggxEnergyTerms` の `W`,`E` | `ComputeFresnelEnergyTerms` [`…Template.ush:55,62`] `W=1+F0*((1-E)/E)`, `E=W*(E*F0+Ef*(F90-F0))` | ✅ 完全一致 |
| 適用 `diffuse*=(1-lum(E))`, `spec*=W` | `ComputeEnergyPreservation/Conservation` [`…Template.ush:130,142`] | ✅ 一致 |

→ DefaultLit の punctual 直接照明 BxDF を、GGX・異方性・EON 拡散・USE_ENERGY_CONSERVATION==2 のエネルギー保存まで含めて**定数レベルで再現**。

### 1.2 補足（差異なし）

- 以前指摘していた「主 Fresnel が `max3` で UE は `.g`」という僅差は、**緑チャンネル `specularColor[1]` に修正済みで解消**。`F_Schlick` と完全一致。
- `NoVRaw<=0` 早期 return ＋ `NoV=saturate(abs(NoVRaw)+1e-5)` のクランプは UE と整合。
- 既定拡散は UE では compile flag で Lambert / Diffuse_GGX_Rough を切替。本 .brdf は `rough_diffuse` bool で公開。妥当。

### 1.3 判定
数式は **修正不要**（UE DefaultLit のローカル BRDF として一致）。ただし energy conservation の既定方針について §1.4 を参照。

### 1.4 energy conservation の既定と「常時 ON 固定」方針（決定事項・実装予定）

#### 仕様調査
UE のエネルギー保存（GGX マルチスキャッタ補正）の既定は [`ShadingEnergyConservation.ush:7-31`](C:/work/unreal/Shaders/Private/ShadingEnergyConservation.ush:7) で **3分岐**:

| プロジェクト構成 | 既定 |
|---|---|
| Substrate 有効（非 legacy GBuffer） | **ON** |
| Substrate 有効＋legacy blendable GBuffer | OFF |
| Substrate 無効 | OFF（ただし cvar `r.Material.EnergyConservation` = `LEGACY_MATERIAL_ENERGYCONSERVATION` が ON なら legacy でも ON） |

→ Substrate「専用」ではない。legacy 材質でも cvar で ON にでき、近年の UE5（Substrate 既定 ON）では実質常時 ON。物理的にも multiscatter 補正は正しい挙動。

#### なぜ問題になったか（前回 §3 の暗さ）
`energy_conservation = 0`（現状の既定）だと GGX 単散乱のエネルギー損失が未補正。`W = 1 + F0·((1-e)/e)` は F0 比例のため **metal で最も差が出る**。`unreal_legacy_pbr.brdf` のコード自体は UE 忠実でバグは無く、原因は **トグル既定 OFF と、比較対象 UE（ON）の食い違い**。

#### 決定
本ビューアでは `energy_conservation` を **トグルから外し、常時 ON 固定**にする（コメントで根拠を明記）。

- 理由: モダン UE5 既定に一致／物理的に正しい／metal・aniso の暗さ（前回 §3）が解消。
- 一致しなくなるのは「Substrate 無効＋cvar OFF の旧プロジェクト」のみで、比較対象として稀。
- 注: 補正は scalar roughness ベース（UE 同様）。異方性の過剰ラフ方向は補正しきれず残差が出るが、これは UE と同じ仕様。
- 注: .brdf は解析近似（`USE_ENERGY_CONSERVATION==2`）。実 UE5 ビューポートは LUT（`==1`）で微差は残る。

---

## 2. `substrate.brdf` — Slab 直接照明評価の高忠実な再現

実 Substrate の直接照明評価は `SubstrateEvaluation.ush` の `SubstrateEvaluateBSDFCommon`。主要ピースを実ソースと突き合わせた結果、**前回レビューで挙げた差異（Fresnel / 拡散結合 / Fuzz 遮蔽 / マルチスキャッタ補償 / 異方性マッピング）は5点とも解消**されている。

### 2.1 照合結果（一致）

| substrate.brdf | 実 Substrate | 判定 |
|---|---|---|
| `fresnelSchlick = F90·Fc+(1−Fc)·F0`（generalized Schlick） | `Substrate_F_GGX=F_Schlick(F0,F90,VoH)` [`SubstrateEvaluation.ush:293`→`BRDF.ush:412`] | ✅ 一致 |
| `F90 = mon2lin(f90)·saturate(50·max3(F0))` | `F90 *= F0RGBToMicroOcclusion(F0)` [`SubstrateEvaluation.ush:488`]（=`saturate(50*max3(F0))`） | ✅ **完全一致** |
| `dGGX` / `dGGXAniso` | `Substrate_D_GGX=D_GGX` / `Substrate_D_GGX_Aniso=D_GGXaniso` [`:267/272`] | ✅ 一致 |
| `visSmithJoint`（厳密 Heitz） | `Substrate_Vis_GGX`（高品質 `Vis_SmithJoint`）[`:277-283`] | ✅ 一致（高品質パス相当） |
| `anisotropicRoughness`: `ax=max(α·(1+aniso),0.001)`, `ay=max(α·(1−aniso),0.001)`, `α=Roughness²` | `GetAnisotropicRoughness(Alpha,Aniso)` [`SubstrateEvaluation.ush:604`→`BRDF.ush:551`] | ✅ 完全一致（線形マッピングへ修正済み。legacy と同式） |
| `msScale=1+F0·((1−e)/e)` をスペキュラへ乗算 | `MSScale=ComputeEnergyConservation` [`:589,683`] | ✅ 一致（マルチスキャッタ補償） |
| `directionalAlbedo=msScale·(e·F0+ef·(F90−F0))`、`energyPreservation=1−lum(...)` | `ComputeGGXSpecEnergyTerms`＋`ComputeEnergyPreservation` [`:587-588`] | ✅ 一致（解析フィット `e`,`ef` も一致） |
| `diffuse = diffuseEON(...) · specularTransmission` | `DiffusePathValue *= ComputeEnergyPreservation` [`:836`] | ✅ 一致（方向アルベド結合） |
| diffuse は EON(`rough*0.4`), `VoL=dot(V,L)` | `Diffuse_GGX_Rough`→`Diffuse_EON` [`:560`]（`2VoH²−1≡V·L`、`rough→0` で Lambert に縮退） | ✅ 一致 |
| Haziness 非クリアコート: `mix(spec0,specHaze,w)`＋`specularTransmission` も lerp | `lerp(SpecularPathValue,Haze,HazeWeight)` [`:807`]＋方向アルベド lerp [`:725`] | ✅ 一致 |
| `second_roughness_as_clearcoat`→ hazeF0=0.04, hazeF90=1.0、上層 throughput で下層減衰 | `bHazeAsSimpleClearCoat` [`:716-719,783-807`] | ✅ 構造一致（簡易版） |
| Fuzz: `dCharlie · visAshikhmin · fresnelSchlickMicroOcclusion(.g)` | `D_Charlie · Vis_Ashikhmin · F_Schlick(FuzzF0)` [`:1101-1104`] | ✅ 一致 |
| `clothDirectionalAlbedoApprox`（`0.526422/(…)+0.0615456`） | `ClothEnergyLookup` 解析フィット [`ShadingEnergyConservation.ush:128`] | ✅ **定数まで一致** |
| Fuzz 下層減衰: `diffuse*=L; specular*=L; specular+=fuzz`、`L=mix(1,1−clothE,amount)` | `DiffusePathValue/SpecularPathValue *= Cloth_..._Transmission` ＋ `+= ClothSpecular` [`:1110-1121`] | ✅ 一致 |

`F90` の扱いが核心: 実 Substrate は **F90 を直接 generalized Schlick に使いつつ、`F0RGBToMicroOcclusion(F0)=saturate(50·max3(F0))` を乗算**する [`SubstrateEvaluation.ush:488`]。現行ファイルはこれを `F90 = mon2lin(f90) · saturate(50·max3(F0))` で正確に再現している（前回の「F90 を色相に正規化」アプローチから置換済み）。

### 2.2 異方性マッピング — 実 Substrate／legacy と一致（修正反映）

`substrate.brdf` の `anisotropicRoughness` は **UE と同じ線形マッピング**に修正済み:
```glsl
float alpha = sqr(perceptualRoughness);                 // = Roughness²
ax = max(alpha * (1.0 + aniso), MIN_GGX_ROUGHNESS);     // MIN_GGX_ROUGHNESS = 0.001
ay = max(alpha * (1.0 - aniso), MIN_GGX_ROUGHNESS);
```
実 Substrate は `GetAnisotropicRoughness(Alpha, SLAB_ANISOTROPY,…)` [`SubstrateEvaluation.ush:604`→`BRDF.ush:551`]:
```glsl
ax = max(Alpha * (1.0 + Anisotropy), 0.001);  ay = max(Alpha * (1.0 - Anisotropy), 0.001);
```
- `Alpha=Roughness²` を線形に分配する点・クランプ `0.001`・符号方向すべて一致。`MIN_GGX_ROUGHNESS(0.001)` で数値も同一。
- これで `unreal_legacy_pbr.brdf` の `anisotropicAlpha` とも揃い、**前回の唯一の残差は解消**。以前の Disney 系 aspect マッピング（`alpha/aspect`）は廃止。

### 2.3 ごく軽微（実用上無視可）

- UE の fuzz ローブは `ComputeEnergyConservation(ClothEnergyTerms)` も乗算する [`:1104`] が、本ファイルでは省略。UE 自身も nuance と注記する程度で影響小。

### 2.4 文書化済みの省略
MFP/SSS/透過・thin surfaces・粗屈折・glints・specular-profile LUT・Sheen LTC LUT・area-light LTC・material graph topology・simplification・deferred storage・path tracing はファイル冒頭どおり省略。Slab 直接項の局所近似として妥当。

### 2.5 判定
**実 Substrate Slab 直接照明評価に非常に近い。** Fresnel(F0/F90)・GGX・異方性・エネルギー保存（MS 補償＋方向アルベド結合）・Haziness・Fuzz（Charlie/Ashikhmin fallback＋下層減衰）まで一致。前回の残差（異方性マッピング）も解消し、評価可能な直接項のローカル近似としては実機にほぼ一致。残るのは §2.3 のごく軽微な fuzz エネルギー保存項と §2.4 の文書化済み省略のみ。

---

## ★ 共通不具合: 異方性×低 roughness でハイライトが消える（`dGGXAniso` の EPS クランプ）

`unreal_legacy_pbr.brdf` と `substrate.brdf` の**両方**に存在する実バグ。`anisotropy != 0` かつ低 roughness のとき、スペキュラハイライトが消えて球が真っ黒になる。数値実験で原因を特定済み。

### 原因
`dGGXAniso` の分母ゼロ除算ガードのしきい値が大きすぎる（`substrate.brdf:89` / `unreal_legacy_pbr.brdf:95`）:
```glsl
float s = dot(v, v);
return (1.0 / PI) * a2 * sqr(a2 / max(s, EPS));   // EPS = 1e-6
```
低 roughness では `a2 = ax·ay` が極小（R=0.10 で a2≈1e-4）。ローブのピーク付近で分母 `s` は 1e-8〜1e-6 まで**正当に**小さくなるのに、`max(s, 1e-6)` が 1e-6 で頭打ちにし、**異方性ローブの芯を潰す**（ピーク値が約1万分の1）→ ハイライト消失 → 真っ黒。

### 証拠（数値実験、R=0.10）
| | ピーク値 (H≈N) | 半球反射率 aniso=0.1 |
|---|---|---|
| EPS=1e-6（現状） | **3.1e-3** | **0.0008**（≒黒） |
| EPS=1e-9 | 32.2 | 0.0400（正しい） |
| EPS=1e-12 | 32.2 | 0.0400（正しい） |

EPS を小さくすると半球反射率は **aniso=0.1〜0.9 で 0.0400 一定**＝**エネルギーは保存している**。よって**異方性 GGX の式自体は正しく**、犯人は EPS クランプのみ。

### なぜ「異方性かつ低 roughness」限定で、なぜ両ファイルで出るか
- 等方パス `dGGX` には同種のクランプが無い（分母 `d=1−NoH²(1−a2)` は自然に a2 以上で 0 にならない）→ 異方性のときだけ発症。
- 高 roughness では出ない: R≥0.3 で a2≥0.0081、ピークの s≈a2²≈6e−5 > 1e−6 でクランプが効かない（実測でも R=0.3 は aniso でほぼ不変）。発症域は roughness≈0.1 以下。
- 両ファイルとも同一コード（`max(dot(v,v), EPS)`, EPS=1e-6）なので同じ症状。
- **UE 本家は無クランプ**: [`D_GGXaniso` BRDF.ush:319](C:/work/unreal/Shaders/Private/BRDF.ush:319) は `Square(a2/S)` を `S=dot(V,V)` のまま使う（`a2*NoH` 項で S>0 が担保）。ポート時に追加した `max(s, 1e-6)` が UE に無い過剰ガードで、値が大きすぎた。

> 注: 以前この症状を「energy 保存の差」「ローブが別方向へ動いた」と説明していたが、それらは**誤り**。本 EPS クランプが真因。

### 修正方針（両ファイル）
- `dGGXAniso` 内の `max(s, EPS)` を専用の極小値へ（例 `max(s, 1e-20)`、実質 UE と同じ。`s` は有効な H では常に >0）。
- **グローバル `EPS=1e-6` は変えない**（`visSmithJoint*` の `max(visV+visL, EPS)` では 1e-6 が適切）。dGGXAniso 専用に小さい値を使う。
```glsl
// dGGXAniso 内のみ
return (1.0 / PI) * a2 * sqr(a2 / max(s, 1e-20));
```
これで低 roughness の異方性ハイライトが復活し、反射率は aniso に対しほぼ一定（エネルギー保存）。高 roughness の挙動は不変。

- 副次（軽微）: `substrate.brdf:177` の `NoH` を 0.9999 にクランプしている点が、等方パスのピークを低 roughness でわずかに下げる（legacy は `saturate` で 0.9999 クランプ無し）。主因ではないので、まずは上記 EPS 修正で十分。

## 3. 推奨アクション（参考・未適用）

1. **【最優先・両ファイル】★節の不具合** — `dGGXAniso` の `max(s, EPS)` を `max(s, 1e-20)` 等の極小値へ（グローバル `EPS=1e-6` は据え置き）。異方性×低 roughness の暗黒化を解消。
2. ~~**substrate §2.2** — 異方性マッピングを線形式へ~~ → **対応済み**（`ax=max(α·(1+aniso),0.001)` 等。legacy／実 Substrate と一致）。
3. **legacy §1.4** — `energy_conservation` を**常時 ON 固定**にする（実装予定）。`bool energy_conservation` パラメータを削除し、`if (energy_conservation)` ガードを外して補正3行を常時実行。根拠をコメントに明記。
4. （任意）substrate §2.3 の fuzz エネルギー保存項（`ComputeEnergyConservation(ClothEnergyTerms)`）を入れるとさらに厳密。影響は小。

### 実装ハンドオフ（legacy §1.4 の具体手順）
`sample/brdf/unreal_legacy_pbr.brdf` を編集:
1. パラメータ宣言の `bool energy_conservation 0` 行を削除。
2. `BRDF()` 内の `if (energy_conservation) { … }` のガードを外し、中の3行（`ggxEnergyTerms(...)` 呼び出し／`diffuse *= saturate(1.0 - luminance(E))`／`specular *= W`）を**常時実行**にする。
3. その箇所に次の主旨のコメント: 「エネルギー保存（GGX マルチスキャッタ補正）は常時 ON 固定。モダン UE5／Substrate 有効時の既定に一致（ShadingEnergyConservation.ush:8）。UE legacy 非 Substrate は `r.Material.EnergyConservation=1` のときのみ ON。補正は scalar roughness ベースで異方性は UE 同様に過小補正の残差あり。」
4. 冒頭の Source model コメントは変更不要（既に `ShadingEnergyConservation.ush` を参照済み）。

---

## 4. 参照ソース（実ファイル:行）

UE シェーダ（`C:\work\unreal\Shaders` 起点）:

- `Private/BRDF.ush` — `D_GGX:311`, `D_GGXaniso:319`, `Vis_SmithJointApprox:373`, `Vis_SmithJoint:382`, `Vis_SmithJointAniso:390`, `F_Schlick:403/412`, `GetAnisotropicRoughness:551`, `Diffuse_Lambert:157`, `Diffuse_EON:213`, `Diffuse_GGX_Rough:238`, `D_Charlie:697`
- `Private/ShadingCommon.ush` — `DielectricSpecularToF0:122`, `F0RGBToF0:112`, `F0RGBToMicroOcclusion:164`, `ComputeF0:169`, `ComputeF90:174`, `ComputeDiffuseAlbedo:179`
- `Private/ShadingModels.ush` — `SpecularGGX:164`, `DefaultLitBxDF:212`
- `Private/ShadingEnergyConservation.ush` — `GGXEnergyLookup`（解析フィット）`:77-78`, `ClothEnergyLookup`（解析フィット）`:128`
- `Private/ShadingEnergyConservationTemplate.ush` — `ComputeFresnelEnergyTerms`（`W`,`E`）`:55,62`, `ComputeEnergyPreservation:126`, `ComputeEnergyConservation:140`
- `Private/Substrate/SubstrateEvaluation.ush` — `Substrate_D_GGX:267`, `Substrate_Vis_GGX:277`, `Substrate_F_GGX:293`, `F90*=F0RGBToMicroOcclusion:488`, 拡散結合 `:560-588/836`, 異方性 `GetAnisotropicRoughness:604`, スペキュラ MS `:589/683`, Haziness lerp `:725/807`, SimpleClearCoat `:716-807`, Fuzz `:1101-1121`
- 参照ガイド: [`docs/unreal_shader_related_files.md`](unreal_shader_related_files.md)
