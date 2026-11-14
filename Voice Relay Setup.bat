@echo off
title NullChat - voice relay setup
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.fly\bin;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Opening the download page...
  echo Install the LTS version, then double-click this file again.
  start https://nodejs.org
  pause
  exit /b 1
)
node scripts\voice-relay.cjs %*
echo.
pause
