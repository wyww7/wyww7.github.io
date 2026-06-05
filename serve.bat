@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo Stopping old Hugo server...
taskkill /F /IM hugo.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo Cleaning cache...
if exist "resources" rmdir /s /q "resources"
if exist "public" rmdir /s /q "public"

echo Starting dev server on http://localhost:1313/
..\hugo.exe server --noHTTPCache --disableFastRender --port 1313
pause
