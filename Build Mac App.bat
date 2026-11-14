@echo off
title Build the NullChat Mac app
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Opening the download page...
  echo Install the LTS version, then double-click this file again.
  start https://nodejs.org
  pause
  exit /b 1
)
node scripts\github-build.cjs %*
echo.
pause
