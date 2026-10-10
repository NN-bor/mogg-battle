@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Нужен Node.js 18 или новее: https://nodejs.org
  echo Или откройте опубликованную версию приложения по https.
  pause
  exit /b 1
)
node scripts\serve.mjs --open
if errorlevel 1 pause
