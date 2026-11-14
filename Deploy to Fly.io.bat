@echo off
setlocal EnableExtensions
title Put NullChat online (Fly.io)
cd /d "%~dp0"

echo.
echo   ===============================================
echo      NullChat  -  put your server online (Fly.io)
echo   ===============================================
echo.
echo   You can run this file again any time to update the server.
echo.

if not exist "Dockerfile" goto :wrongfolder
if not exist "fly.toml" goto :wrongfolder

where node >nul 2>nul
if errorlevel 1 goto :nonode

rem ---- 1. The Fly.io tool ---------------------------------------------------
set "PATH=%USERPROFILE%\.fly\bin;%PATH%"
where fly >nul 2>nul
if not errorlevel 1 goto :have_fly
echo [1/6] Installing the Fly.io tool...
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr https://fly.io/install.ps1 -useb | iex"
set "PATH=%USERPROFILE%\.fly\bin;%PATH%"
where fly >nul 2>nul
if errorlevel 1 goto :nofly
:have_fly
echo [1/6] Fly.io tool ready.

rem ---- 2. Log in ------------------------------------------------------------
fly auth whoami >nul 2>nul
if not errorlevel 1 goto :logged_in
echo [2/6] A browser window will open. Log in or sign up, then come back here.
fly auth login
if errorlevel 1 goto :fail
:logged_in
echo [2/6] Logged in to Fly.io.

rem ---- 3. Pick the app name -------------------------------------------------
set "DEFAULT_NAME="
for /f "delims=" %%a in ('node scripts\fly-rename.cjs --print-name') do set "DEFAULT_NAME=%%a"
set "REGION=ord"
for /f "delims=" %%a in ('node scripts\fly-rename.cjs --print-region') do set "REGION=%%a"
:askname
echo.
echo [3/6] Choose a name. Your server will live at  https://NAME.fly.dev
set "APPNAME="
set /p "APPNAME=Name (press Enter for %DEFAULT_NAME%): "
if "%APPNAME%"=="" set "APPNAME=%DEFAULT_NAME%"
node scripts\fly-rename.cjs %APPNAME%
if errorlevel 1 goto :askname

fly status -a %APPNAME% >nul 2>nul
if not errorlevel 1 goto :have_app
fly apps create %APPNAME%
if errorlevel 1 goto :create_failed
:have_app
echo [3/6] App "%APPNAME%" ready.

rem ---- 4. Disk for the database and uploads ---------------------------------
fly volumes list -a %APPNAME% 2>nul | findstr /c:"nullchat_data" >nul
if not errorlevel 1 goto :have_volume
echo [4/6] Creating a 3 GB disk for your data in region %REGION%...
fly volumes create nullchat_data --size 3 --region %REGION% --yes -a %APPNAME%
if errorlevel 1 goto :fail
:have_volume
node scripts\fly-snapshots.cjs %APPNAME%
echo [4/6] Data disk ready.

rem ---- 5. Secret login key (created once, never changed) -------------------
fly secrets list -a %APPNAME% 2>nul | findstr /c:"APP_SECRET" >nul
if not errorlevel 1 goto :have_secret
set "NEWSECRET="
for /f "delims=" %%s in ('node scripts\gen-secret.cjs') do set "NEWSECRET=%%s"
if "%NEWSECRET%"=="" goto :fail
fly secrets set APP_SECRET=%NEWSECRET% --stage -a %APPNAME%
if errorlevel 1 goto :fail
set "NEWSECRET="
:have_secret
echo [5/6] Secret key ready.

rem ---- The desktop app: built here when the downloads folder has none, or an older one ----
rem (a fresh unzip of NullChat has an empty downloads folder; without this the installed apps never get the update)
echo.
node scripts\need-installer.cjs
if not errorlevel 1 goto :installer_ok
echo   Building the Windows desktop app now, so it goes online with this update.
echo   This takes a few minutes (longer the first time). Leave this window open.
echo.
set "NULLCHAT_SERVER_URL=https://%APPNAME%.fly.dev"
call npm install --no-audit --no-fund
if errorlevel 1 goto :installer_failed
call npm run desktop:win
if errorlevel 1 goto :installer_failed
if not exist "desktop\release\NullChatSetup.exe" goto :installer_failed
if not exist downloads mkdir downloads
copy /y "desktop\release\NullChatSetup.exe" "downloads\" >nul
copy /y "desktop\release\NullChatSetup.exe.blockmap" "downloads\" >nul 2>nul
copy /y "desktop\release\latest.yml" "downloads\" >nul
if exist data if not exist data\downloads mkdir data\downloads
if exist data copy /y "desktop\release\NullChatSetup.exe" "data\downloads\" >nul
if exist data copy /y "desktop\release\NullChatSetup.exe.blockmap" "data\downloads\" >nul 2>nul
if exist data copy /y "desktop\release\latest.yml" "data\downloads\" >nul
echo.
echo   Desktop app built.
goto :installer_ok
:installer_failed
echo.
echo   The desktop app could not be built (scroll up to see why). The website is still being updated;
echo   the desktop app stays as it was. You can try again later with "Build Installer.bat".
:installer_ok

rem ---- Is the installer in the downloads folder whole? (stops a damaged one from going online) ----
echo.
node scripts\check-downloads.cjs
if errorlevel 2 goto :baddownloads

rem ---- 6. Upload and start --------------------------------------------------
echo.
echo [6/6] Uploading and starting NullChat. The first time takes a few minutes...
fly deploy --ha=false -a %APPNAME%
if errorlevel 1 goto :fail

echo.
echo Checking the installer on the server...
node scripts\check-downloads.cjs --live https://%APPNAME%.fly.dev
set "LIVECHECK=%errorlevel%"

echo.
echo   ===============================================
echo    Done!  NullChat is online at:
echo.
echo        https://%APPNAME%.fly.dev
echo   ===============================================
echo.
echo   1. Open that address in your browser and create your account.
echo   2. Make a server, click "Invite People", and send the link to friends.
echo      Friends can just open the link in a browser, no install needed.
echo   3. The desktop app is in "Download Apps" on the site. People who already have it
echo      get the update the next time they open it.
echo.
if "%LIVECHECK%"=="3" echo   The installer on the server is NOT right yet: run this file once more (see the message above).
if "%LIVECHECK%"=="3" echo.
start "" "https://%APPNAME%.fly.dev"
pause
exit /b 0

:baddownloads
echo.
pause
exit /b 1

:wrongfolder
echo   This file must stay inside the "nullchat" folder, right next to the file named
echo   "Dockerfile". Move it back there and double-click it again.
echo.
pause
exit /b 1

:nonode
echo   Node.js is not installed. Opening the download page.
echo   Install the LTS version, then double-click this file again.
start "" "https://nodejs.org"
pause
exit /b 1

:nofly
echo   The Fly.io tool did not install. Close this window and run this file again.
echo   If it still fails, install it by hand from https://fly.io/docs/flyctl/install/
echo.
pause
exit /b 1

:create_failed
echo.
echo   Could not create "%APPNAME%". The usual reasons:
echo     - That name is already taken by someone else. Type a different name next.
echo     - Fly needs a payment method on your account. Add one at
echo       https://fly.io/dashboard  (Billing), then press Enter to try the same name again.
echo.
pause
goto :askname

:fail
echo.
echo   Something went wrong. Scroll up to see the message and send it to Claude.
echo   After a deploy, "fly logs" shows what the server is printing.
echo.
pause
exit /b 1
