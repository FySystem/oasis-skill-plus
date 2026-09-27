@echo off
call "%~dp0scripts\sync-rust.bat" sync-wiki %*
exit /b %ERRORLEVEL%
