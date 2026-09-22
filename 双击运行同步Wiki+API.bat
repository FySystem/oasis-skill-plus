@echo off
call "%~dp0scripts\sync-rust.bat" sync-all %*
exit /b %ERRORLEVEL%
