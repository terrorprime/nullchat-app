@echo off
setlocal EnableExtensions
title NullChat - account help (Fly.io)
cd /d "%~dp0"

echo.
echo   ===============================================
echo      NullChat  -  account help (Fly.io server)
echo   ===============================================
echo.
echo   Use this if you cannot log in to your online server.
echo   It can show which accounts exist and set a new password.
echo.

if not exist "fly.toml" goto :wrongfolder
set "PATH=%USERPROFILE%\.fly\bin;%PATH%"
where fly >nul 2>nul
if errorlevel 1 goto :nofly
fly auth whoami >nul 2>nul
if errorlevel 1 (
  echo   You are not logged in to Fly.io. A browser window will open.
  fly auth login
  if errorlevel 1 goto :fail
)

set "APPNAME="
for /f "usebackq tokens=2 delims==" %%a in (`findstr /b /c:"app = " fly.toml`) do set "APPNAME=%%a"
set "APPNAME=%APPNAME: =%"
set "APPNAME=%APPNAME:"=%"
if "%APPNAME%"=="" goto :wrongfolder
echo   Server: %APPNAME%  (https://%APPNAME%.fly.dev)
echo.

:menu
echo   What would you like to do?
echo     1  Show all accounts on this server
echo     2  Set a new password for an account
echo     3  Lift a suspension from an account
echo     4  Quit
echo.
set "CHOICE="
set /p "CHOICE=  Type 1, 2, 3 or 4 and press Enter: "
if "%CHOICE%"=="1" goto :list
if "%CHOICE%"=="2" goto :password
if "%CHOICE%"=="3" goto :unsuspend
if "%CHOICE%"=="4" goto :end
goto :menu

:list
echo.
fly ssh console -a %APPNAME% -C "node --disable-warning=ExperimentalWarning scripts/account.js list"
echo.
goto :menu

:password
echo.
set "WHO="
set /p "WHO=  Username or email of the account: "
if "%WHO%"=="" goto :menu
echo   Choose a new password: 8 or more letters and numbers (no spaces or symbols, to keep this simple).
set "NEWPW="
set /p "NEWPW=  New password: "
if "%NEWPW%"=="" goto :menu
fly ssh console -a %APPNAME% -C "node --disable-warning=ExperimentalWarning scripts/account.js password %WHO% %NEWPW%"
echo.
goto :menu

:unsuspend
echo.
set "WHO="
set /p "WHO=  Username or email of the account: "
if "%WHO%"=="" goto :menu
fly ssh console -a %APPNAME% -C "node --disable-warning=ExperimentalWarning scripts/account.js unsuspend %WHO%"
echo.
goto :menu

:wrongfolder
echo   This file has to stay in the NullChat folder (next to fly.toml).
goto :fail
:nofly
echo   The Fly.io tool is not installed yet. Run "Deploy to Fly.io.bat" first.
goto :fail
:fail
echo.
pause
exit /b 1
:end
endlocal
exit /b 0
