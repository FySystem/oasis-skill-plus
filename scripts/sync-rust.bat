@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "COMMAND=%~1"
set "PAUSE_MODE=%~2"
if /i not "%COMMAND%"=="sync-wiki" if /i not "%COMMAND%"=="sync-api" if /i not "%COMMAND%"=="sync-all" goto invalid_command

cd /d "%~dp0.."
for /f "tokens=2 delims=:" %%I in ('chcp') do set "ORIGINAL_CODE_PAGE=%%I"
set "ORIGINAL_CODE_PAGE=%ORIGINAL_CODE_PAGE: =%"
chcp 65001 >nul

set "BINARY=target\release\oasis-skill-plus.exe"
if not exist "%BINARY%" goto build_release
goto run_sync

:build_release
where cargo >nul 2>nul
if not errorlevel 1 goto cargo_ready
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
    set "CARGO=%USERPROFILE%\.cargo\bin\cargo.exe"
    goto cargo_ready
)
goto cargo_not_found

:cargo_ready
if not defined CARGO set "CARGO=cargo"
echo [信息] 未找到 Rust release 程序，正在构建...
"%CARGO%" build --release
if errorlevel 1 goto build_failed

:run_sync
if /i "%COMMAND%"=="sync-wiki" echo [信息] 开始同步 Oasis Wiki...
if /i "%COMMAND%"=="sync-api" echo [信息] 开始同步 Oasis API...
if /i "%COMMAND%"=="sync-all" echo [信息] 开始同步 Oasis Wiki 和 API...
"%BINARY%" %COMMAND%
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" goto sync_success
echo [失败] 同步失败，退出码：%EXIT_CODE%。
goto finish

:sync_success
echo [完成] 同步已完成。
goto finish

:invalid_command
echo [错误] 用法：scripts\sync-rust.bat sync-wiki^|sync-api^|sync-all [--no-pause]
set "EXIT_CODE=2"
goto finish

:cargo_not_found
echo [错误] 未在 PATH 中找到 Cargo，请先安装 Rust 工具链。
set "EXIT_CODE=1"
goto finish

:build_failed
set "EXIT_CODE=%ERRORLEVEL%"
echo [失败] Rust release 构建失败，退出码：%EXIT_CODE%。
goto finish

:finish
if /i not "%PAUSE_MODE%"=="--no-pause" call :wait_for_key
if defined ORIGINAL_CODE_PAGE chcp %ORIGINAL_CODE_PAGE% >nul
exit /b %EXIT_CODE%

:wait_for_key
echo 请按任意键继续...
pause >nul
goto :eof
