@echo off
title Build the NullChat installer
cd /d "%~dp0"
echo.
echo   =============================================
echo      NullChat  -  build the Windows installer
echo   =============================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Opening the download page...
  echo Install the LTS version, then double-click this file again.
  start https://nodejs.org
  pause
  exit /b 1
)
set "BAKED="
for /f "delims=" %%a in ('node scripts\fly-rename.cjs --print-url') do set "BAKED=%%a"
if defined BAKED goto :askbaked
echo Which NullChat server should the app open automatically?
echo   - Type its address, e.g.  https://chat.example.com   or   192.168.1.23:3001
echo   - Or just press Enter: the app will ask on first launch
echo     ("Host on this computer" or "Join a server").
echo.
set "NULLCHAT_SERVER_URL="
set /p "NULLCHAT_SERVER_URL=Server address: "
goto :askdone
:askbaked
echo The app is set to open your online server:  %BAKED%
echo   - Press Enter to keep it, or type a different address.
echo.
set "NULLCHAT_SERVER_URL="
set /p "NULLCHAT_SERVER_URL=Server address [%BAKED%]: "
if not defined NULLCHAT_SERVER_URL set "NULLCHAT_SERVER_URL=%BAKED%"
:askdone
echo.
echo [1/2] Installing tools (first time takes a few minutes)...
call npm install --no-audit --no-fund
if errorlevel 1 ( echo. & echo Install failed. Check your internet connection. & pause & exit /b 1 )
echo.
echo [2/2] Building NullChatSetup.exe ...
call npm run desktop:win
if errorlevel 1 ( echo. & echo Build failed - scroll up to see why. & pause & exit /b 1 )

rem Publish the installer + update files:
rem   data\downloads  = the server running on this computer
rem   downloads       = shipped with every "Deploy to Fly.io.bat", so your online server offers them too
rem                     and apps that are already installed update themselves.
if not exist data\downloads mkdir data\downloads
if not exist downloads mkdir downloads
copy /y "desktop\release\NullChatSetup.exe" "data\downloads\" >nul
copy /y "desktop\release\NullChatSetup.exe.blockmap" "data\downloads\" >nul 2>nul
copy /y "desktop\release\latest.yml" "data\downloads\" >nul
copy /y "desktop\release\NullChatSetup.exe" "downloads\" >nul
copy /y "desktop\release\NullChatSetup.exe.blockmap" "downloads\" >nul 2>nul
copy /y "desktop\release\latest.yml" "downloads\" >nul

echo.
echo   Done!  Your installer is:  desktop\release\NullChatSetup.exe
echo.
echo   - Double-click it to install NullChat (no admin needed, installs in seconds).
echo   - To update the NullChat app for everyone who already has it, double-click
echo     "Deploy to Fly.io.bat" now. The new files were copied into the "downloads"
echo     folder, so your online server offers them and installed apps update themselves
echo     the next time they start.
echo.
explorer "desktop\release"
pause
