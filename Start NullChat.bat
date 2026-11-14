@echo off
title NullChat
cd /d "%~dp0"
echo.
echo   ==============================
echo           NullChat launcher
echo   ==============================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Opening the download page...
  echo Install the LTS version, then double-click this file again.
  start https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  echo [1/3] Installing dependencies - first run only, takes about a minute...
  call npm install --no-audit --no-fund
  if errorlevel 1 ( echo Install failed. Check your internet connection. & pause & exit /b 1 )
)
if not exist .env (
  call npm run setup
  if errorlevel 1 ( pause & exit /b 1 )
)
if not exist client\dist\index.html (
  echo [2/3] Building the web app - first run only...
  call npm run build
  if errorlevel 1 ( echo Build failed. & pause & exit /b 1 )
)
echo [3/3] Starting NullChat on http://localhost:3001
echo       Keep this window open. Close it to stop NullChat.
echo.
set PUBLIC_URL=http://localhost:3001
start "" http://localhost:3001
call npm start
pause
