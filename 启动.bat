@echo off
chcp 65001 >nul
title Scribe Writing Studio - Server Log
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 22+ first: https://nodejs.org/
  pause
  exit /b 1
)
node scripts\launch.mjs
echo.
pause
