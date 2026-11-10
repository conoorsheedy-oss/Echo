@echo off
rem Echo one-click setup: double-click this file. It runs setup.ps1 (next to
rem this file) without changing your PowerShell settings, then waits so you
rem can read the result.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
set "ECHO_SETUP_EXIT=%ERRORLEVEL%"
echo.
if not "%ECHO_SETUP_EXIT%"=="0" echo Setup did not finish (exit code %ECHO_SETUP_EXIT%). Read the messages above.
pause
exit /b %ECHO_SETUP_EXIT%
