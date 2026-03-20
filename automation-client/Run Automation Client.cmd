@echo off
setlocal
set "APP_DIR=%~dp0"
set "PS_SCRIPT=%APP_DIR%scripts\start-automation-client.ps1"

if not exist "%PS_SCRIPT%" exit /b 1

powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%PS_SCRIPT%"
endlocal
