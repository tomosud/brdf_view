@echo off
rem Local preview of BRDF Explorer Web.
rem   run.bat          : dev server (http://localhost:5173/), opens the browser
rem   run.bat pages    : production build, then serve it like GitHub Pages
rem                      (http://localhost:4173/brdf_view/)
setlocal
set "ROOT=%~dp0"
cd /d "%ROOT%web"

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js / npm not found. Install Node.js 22 LTS: https://nodejs.org/
  pause
  exit /b 1
)

rem Install dependencies on first run or when package-lock.json changed.
set "STAMP=node_modules\.package-lock.json"
if not exist "%STAMP%" goto install
for /f %%i in ('powershell -NoProfile -Command "if ((Get-Item 'package-lock.json').LastWriteTime -gt (Get-Item '%STAMP%').LastWriteTime) { 'stale' }"') do goto install
goto installed
:install
echo Installing dependencies (npm ci)...
call npm ci
if errorlevel 1 (
  echo npm ci failed.
  pause
  exit /b 1
)
:installed

if /i "%~1"=="pages" goto pages

echo Starting dev server. Close this window or press Ctrl+C to stop.
call npm run dev
goto end

:pages
call npm run build
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)
call "%ROOT%serve_pages_local.bat"

:end
endlocal
