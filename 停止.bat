@echo off
chcp 65001 >nul
title Scribe Writing Studio - Stop
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  pause
  exit /b 1
)
node scripts\stop.mjs
echo.
pause
