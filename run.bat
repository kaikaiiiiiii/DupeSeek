@echo off
rem DupeSeek dev launcher: install deps if missing, then run electron-vite dev
cd /d "%~dp0"

if not exist node_modules (
  echo [run.bat] first run: installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [run.bat] npm install failed
    pause
    exit /b 1
  )
)

call npm run dev
