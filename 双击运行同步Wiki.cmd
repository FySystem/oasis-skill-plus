@echo off
setlocal

cd /d "%~dp0"
for /f "tokens=2 delims=:" %%I in ('chcp') do set "ORIGINAL_CODE_PAGE=%%I"
set "ORIGINAL_CODE_PAGE=%ORIGINAL_CODE_PAGE: =%"
chcp 65001 >nul

where node >nul 2>nul
if errorlevel 1 goto node_not_found

echo [信息] 开始同步 Oasis Wiki...
node src\cli.mjs sync
set "EXIT_CODE=%ERRORLEVEL%"
echo.

if "%EXIT_CODE%"=="0" goto sync_success

echo [失败] 同步失败，退出码：%EXIT_CODE%。
goto script_end

:node_not_found
echo [错误] 未在 PATH 中找到 Node.js。
echo 请先安装 Node.js，或在可使用 node 的终端中运行此脚本。
if /i not "%~1"=="--no-pause" call :wait_for_key
call :restore_code_page
exit /b 1

:sync_success
echo [完成] 同步已完成。

:script_end
if /i not "%~1"=="--no-pause" call :wait_for_key
call :restore_code_page
exit /b %EXIT_CODE%

:wait_for_key
echo 请按任意键继续...
pause >nul
goto :eof

:restore_code_page
if defined ORIGINAL_CODE_PAGE chcp %ORIGINAL_CODE_PAGE% >nul
goto :eof
