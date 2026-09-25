@echo off
node "%~dp0..\fake-pnpm.mjs" %*
exit /b %ERRORLEVEL%
