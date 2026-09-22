@echo off
call "%~dp0scripts\sync-rust.bat" sync-api %*
exit /b %ERRORLEVEL%
