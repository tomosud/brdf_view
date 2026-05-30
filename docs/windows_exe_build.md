# BRDF Explorer Windows exe Build Notes

目的: Web 版の比較対象として、`sample/brdf-main` から Windows 版 `brdf.exe` を作る。

## 結論

作成済み。比較用に直接起動しやすいフォルダは次。

```text
build/brdf-runtime/brdf.exe
```

`build/brdf-runtime` には exe、Qt DLL、MinGW runtime DLL、Qt platform plugin、元アプリが相対パスで読む `brdfs/`, `data/`, `images/`, `probes/`, `shaderTemplates/` を同じ階層に置いた。Explorer から `brdf.exe` を直接起動できる。

短時間の起動確認では、PATH を追加しない状態で `build/brdf-runtime` を working directory にして起動し、5 秒後もプロセスが生存していた。

## 同梱状況

`sample/brdf-main` には exe は同梱されていない。旧 `brdf-1.0.0-win32.zip` は過去に GitHub Downloads で配布されていた記録があるが、現在の URL は 404 で、GitHub releases/tags にも配布物はない。

この workspace では作業開始時点で `qmake`, C++ compiler, `mingw32-make`, MSYS2 が未導入だった。`cmake` は入っているが、このプロジェクトは CMake ではなく qmake `.pro` ベース。

## 必要なもの

今回は MSYS2 UCRT64 + MinGW + Qt5 でビルドした。古い `README-WIN32` は Visual Studio 2010 + Qt 4.8.1 + GLEW/GLUT/ZLib を想定しているが、現在の `src/brdf/brdf.pro` は Qt5 設定になっている。

必要パッケージ:

- `mingw-w64-ucrt-x86_64-gcc`
- `mingw-w64-ucrt-x86_64-qt5-base`
- `mingw-w64-ucrt-x86_64-qt5-tools`
- `mingw-w64-ucrt-x86_64-zlib`
- `mingw-w64-ucrt-x86_64-make`
- `mingw-w64-ucrt-x86_64-ntldd`

## セットアップ

MSYS2 がない場合:

```powershell
winget install --id MSYS2.MSYS2 --exact --silent --accept-package-agreements --accept-source-agreements
```

MSYS2 導入後、UCRT64 パッケージを入れる。

```powershell
C:\msys64\usr\bin\bash.exe -lc "pacman -Syu --noconfirm"
C:\msys64\usr\bin\bash.exe -lc "pacman -S --noconfirm --needed mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-qt5-base mingw-w64-ucrt-x86_64-qt5-tools mingw-w64-ucrt-x86_64-zlib mingw-w64-ucrt-x86_64-make mingw-w64-ucrt-x86_64-ntldd"
```

`pacman -Syu` の後に MSYS2 runtime 更新で shell 再起動が必要になることがある。その場合は同じ `bash.exe -lc` コマンドを再実行する。

## ビルド

実際に通った out-of-source build:

```powershell
C:\msys64\usr\bin\bash.exe -lc "export MSYSTEM=UCRT64; source /etc/profile; mkdir -p /c/work/script/brdf_view/build/brdf-mingw /c/work/script/brdf_view/build/brdf-install; cd /c/work/script/brdf_view/build/brdf-mingw && /ucrt64/bin/qmake-qt5 -r /c/work/script/brdf_view/sample/brdf-main/main.pro prefix=/c/work/script/brdf_view/build/brdf-install"
C:\msys64\usr\bin\bash.exe -lc "export MSYSTEM=UCRT64; source /etc/profile; cd /c/work/script/brdf_view/build/brdf-mingw && /ucrt64/bin/mingw32-make -j2"
C:\msys64\usr\bin\bash.exe -lc "export MSYSTEM=UCRT64; source /etc/profile; cd /c/work/script/brdf_view/build/brdf-mingw && /ucrt64/bin/mingw32-make install"
```

注意: PowerShell のダブルクォート内で `-j$(nproc)` と書くと PowerShell 側が `$(nproc)` を評価しようとする。この環境では結果的に `mingw32-make -j` 相当になり、並列数無制限でコンパイラがメモリ不足になった。PowerShell から実行するなら `-j2` のように明示する。

ビルド成果物:

```text
build/brdf-mingw/src/brdf/release/brdf.exe
build/brdf-install/bin/brdf.exe
build/brdf-install/share/brdf/brdfs
build/brdf-install/share/brdf/data
build/brdf-install/share/brdf/images
build/brdf-install/share/brdf/probes
build/brdf-install/share/brdf/shaderTemplates
```

## Runtime フォルダ

元コードの `Paths.cpp` は `./data/`, `./images/`, `./probes/`, `./shaderTemplates/` をカレントディレクトリ相対で参照する。`make install` のままだと exe は `bin/`、資産は `share/brdf/` に分かれるため、Explorer から直接起動すると資産を見つけられない。

比較用には次のように runtime フォルダへまとめた。

```powershell
$runtime = "c:\work\script\brdf_view\build\brdf-runtime"
New-Item -ItemType Directory -Force -Path $runtime
Copy-Item c:\work\script\brdf_view\build\brdf-install\bin\brdf.exe $runtime -Force
Copy-Item c:\work\script\brdf_view\build\brdf-install\share\brdf\brdfs $runtime -Recurse -Force
Copy-Item c:\work\script\brdf_view\build\brdf-install\share\brdf\data $runtime -Recurse -Force
Copy-Item c:\work\script\brdf_view\build\brdf-install\share\brdf\images $runtime -Recurse -Force
Copy-Item c:\work\script\brdf_view\build\brdf-install\share\brdf\probes $runtime -Recurse -Force
Copy-Item c:\work\script\brdf_view\build\brdf-install\share\brdf\shaderTemplates $runtime -Recurse -Force
```

`windeployqt-qt5` は Qt DLL をコピーするが、MSYS2 UCRT64 のこの構成では `libGLESv2.dll does not exist` で非ゼロ終了した。OpenGL 版の本体起動に必要な Qt DLL はコピー済みだったため、MinGW runtime と platform plugin は手動で補った。

```powershell
C:\msys64\ucrt64\bin\windeployqt-qt5.exe --compiler-runtime c:\work\script\brdf_view\build\brdf-runtime\brdf.exe
```

手動コピーした主な DLL:

```text
Qt5Core.dll
Qt5Gui.dll
Qt5Widgets.dll
libgcc_s_seh-1.dll
libstdc++-6.dll
libwinpthread-1.dll
zlib1.dll
libdouble-conversion.dll
libicuin78.dll
libicuuc78.dll
libicudt78.dll
libpcre2-16-0.dll
libzstd.dll
libharfbuzz-0.dll
libfreetype-6.dll
libbrotlidec.dll
libbrotlicommon.dll
libbz2-1.dll
libglib-2.0-0.dll
libintl-8.dll
libiconv-2.dll
libpcre2-8-0.dll
libgraphite2.dll
libmd4c.dll
libpng16-16.dll
platforms/qwindows.dll
```

依存確認には次を使った。

```powershell
C:\msys64\usr\bin\bash.exe -lc "export MSYSTEM=UCRT64; source /etc/profile; ntldd -R /c/work/script/brdf_view/build/brdf-runtime/brdf.exe"
```

## 起動確認

PATH を追加せず、runtime フォルダを working directory にして起動:

```powershell
$runtime = "c:\work\script\brdf_view\build\brdf-runtime"
$p = Start-Process -FilePath "$runtime\brdf.exe" -WorkingDirectory $runtime -PassThru
Start-Sleep -Seconds 5
$p.HasExited
```

結果: `False`。起動直後に DLL 不足や資産不足で終了する状態ではない。

## ビルド時の警告

ソース修正なしでビルドは通った。警告は古い Qt/C++ コードに由来するものが中心。

- `QDesktopWidget::screenGeometry` deprecated
- `QFlags(0)` deprecated
- C++20 で template-id constructor/destructor が非推奨
- `std::ptr_fun` / `std::not1` deprecated
- `Quad` 周辺の possible uninitialized warning

Web 版の一次資料としての挙動を保つため、比較用 exe のためのソース変更は行っていない。
