@echo off
rem DupeSeek dev launcher: install deps if missing, then run electron-vite dev
title DupeSeek dev
cd /d "%~dp0"

if not exist node_modules (
  echo [DupeSeek.bat] first run: installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [DupeSeek.bat] npm install failed
    pause
    exit /b 1
  )
  rem npm 会用 process.title 覆盖控制台标题（Windows 上即 SetConsoleTitle），装完补回
  title DupeSeek dev
)

rem 绕过 npm 直接调用 electron-vite CLI：npm 入口同样会覆盖窗口标题
call node node_modules\electron-vite\bin\electron-vite.js dev
