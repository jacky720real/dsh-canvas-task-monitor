@echo off
rem Wrapper: picks pwsh when available, otherwise Windows PowerShell 5.1.
rem All logic lives in rollback.ps1 next to this file.
setlocal
set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"
"%PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0rollback.ps1" %*
set "CODE=%ERRORLEVEL%"
endlocal & exit /b %CODE%
