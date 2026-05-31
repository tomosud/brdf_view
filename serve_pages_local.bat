@echo off
setlocal

set "ROOT=%~dp0"
set "PORT=4173"
set "URL=http://localhost:%PORT%/brdf_view/"

if not exist "%ROOT%web\dist\index.html" (
  echo web\dist\index.html not found.
  echo Run "cd web && npm run build" first.
  pause
  exit /b 1
)

start "" "%URL%"
python "%ROOT%scripts\serve_pages_local.py" --root "%ROOT%web\dist" --port "%PORT%" --prefix "/brdf_view/"

