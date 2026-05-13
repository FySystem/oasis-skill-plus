@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  echo Please install Node.js or open a terminal where node is available.
  if /i not "%~1"=="--no-pause" pause
  exit /b 1
)

echo [INFO] Starting Oasis wiki and API sync...
node src\cli.mjs sync-all
set "EXIT_CODE=%ERRORLEVEL%"
echo.

if "%EXIT_CODE%"=="0" (
  echo [OK] Sync finished.
  echo [INFO] Open this folder to inspect the markdown files:
  echo   docs\
  if /i not "%~1"=="--no-pause" start "" "%~dp0docs"
) else (
  echo [FAIL] Sync failed with exit code %EXIT_CODE%.
)

if /i not "%~1"=="--no-pause" pause
exit /b %EXIT_CODE%
