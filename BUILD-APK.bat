@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-apk.ps1" -Install
echo.
echo Finished. See build-log.txt. You can close this window.
pause
