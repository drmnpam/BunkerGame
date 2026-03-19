@echo off
setlocal

title Kapture Automation Agent Launcher
set "APP_DIR=%~dp0"
set "PS_SCRIPT=%APP_DIR%scripts\start-automation-client.ps1"
set "LOGO=%APP_DIR%branding\logo.png"

echo =======================================
echo   Kapture Automation Agent Launcher
if exist "%LOGO%" echo   Logo: %LOGO%
echo =======================================

if not exist "%PS_SCRIPT%" (
  echo [launcher] Script not found: %PS_SCRIPT%
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"

endlocal
