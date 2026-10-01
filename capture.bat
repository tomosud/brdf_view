@echo off
rem Headless capture of BRDF Explorer Web (PNG renders, numeric data, BRDF evaluation).
rem Same options as web\scripts\capture.mjs; paths are relative to the current folder.
rem   capture.bat --brdf callisto_brdf.brdf --light 60,0 --view litObject --out out.png
rem   capture.bat --url "<shared link>" --view slice --out slice.png --data slice.csv
rem   capture.bat --batch jobs.json
rem   capture.bat --help
setlocal
set "WEB=%~dp0web"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node.js 22 LTS: https://nodejs.org/
  exit /b 1
)

rem Install dependencies on first run or when package-lock.json changed (same as run.bat).
set "STAMP=%WEB%\node_modules\.package-lock.json"
if not exist "%STAMP%" goto install
if not exist "%WEB%\node_modules\playwright" goto install
for /f %%i in ('powershell -NoProfile -Command "if ((Get-Item '%WEB%\package-lock.json').LastWriteTime -gt (Get-Item '%STAMP%').LastWriteTime) { 'stale' }"') do goto install
goto installed
:install
echo Installing dependencies (npm ci)...
pushd "%WEB%"
call npm ci
if errorlevel 1 (
  popd
  echo npm ci failed.
  exit /b 1
)
popd
:installed

node "%WEB%\scripts\capture.mjs" %*
set "RC=%ERRORLEVEL%"
endlocal & exit /b %RC%
