@echo off
call "%~dp0scripts\sync-rust.bat" sync %*
exit /b %ERRORLEVEL%
