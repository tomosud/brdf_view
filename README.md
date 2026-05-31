# BRDF Explorer Web

Disney BRDF Explorer をブラウザで使えるようにした Web 版です。

- Web app: https://tomosud.github.io/brdf_view/

<img width="1700" height="899" alt="image" src="https://github.com/user-attachments/assets/30943e8d-63ab-4fca-9189-55b841eaeb76" />
  

## できること

- `.brdf` ファイルを読み込んで表示できます。
- MERL の `.binary` BRDF ファイルを読み込めます。
- サンプル BRDF をアプリ内から選択して読み込めます。
- BRDF パラメータを調整しながら、複数のビューで見た目を確認できます。
- オリジナルの BRDF Explorer runtime を比較対象として置きました。
- - Windows comparison runtime: https://github.com/tomosud/brdf_view/releases/tag/brdf-runtime-v0.1.0

## 使い方

1. Web app を開きます。
2. `Open BRDF...` から `.brdf` または `.binary` ファイルを選びます。
3. サンプルを試す場合は `Load sample Brdf` を押して、一覧から選びます。
4. 左側のパラメータで表示するBRDFを選び、値を調整します。

MERL BRDF Database の測定BRDFは以下から入手できます。

https://www.merl.com/research/downloads/BRDF

## ビュー

- `3D Plot`: BRDFの形状を3Dで確認できます。
- `Polar Plot`: 角度方向の分布を極座標で確認できます。
- `Theta V`: 視線角度に対する変化を確認できます。
- `Image Slice`: BRDFの断面を画像または高さ表示で確認できます。
- `Lit Object`: HDRI環境光で球やティーポットを照らして確認できます。
- `Lit Sphere`: 元のBRDF Explorerに近い球表示で確認できます。

## 追加機能

- GitHub Pages でそのまま使える Web アプリとして公開。
- サンプルBRDFの読み込み。
- HDRI環境マップの切り替え。
- Lit Object のオブジェクト切り替え。
- Lit Object の背景HDRI非表示モード。
- Lit Object の無彩色IBLモード。
- Image Slice のHDR値読み取り。
- Image Slice の3D高さ表示。
- Plot / Image Slice の対数表示。
- 表示BRDFを1つに絞る折りたたみ式パラメータパネル。
- カラーパラメータ用の専用ピッカー。
- 上下ビュー領域のリサイズ。

## 比較用 Windows Runtime

元のデスクトップ版と見比べるための Windows runtime を GitHub Releases に置いています。

https://github.com/tomosud/brdf_view/releases/tag/brdf-runtime-v0.1.0

Web版の表示確認や挙動比較に使えます。

## Attribution

This project is based on the Disney BRDF Explorer.

Original project:

https://github.com/wdas/brdf

Original Disney BRDF Explorer files carry Disney Enterprises copyright and license notices.
Redistributed files should keep the bundled license and attribution files.
