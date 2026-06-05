@echo off
chcp 65001 >nul

set HUGO_PATH=C:\software\other\hugo\hugo_extended_withdeploy_0.161.1_windows-amd64
set REPO_URL=https://github.com/wyww7/wyww7.github.io
cd /d "%~dp0"

echo =======================================
echo  1. Backup source code to main branch...
echo =======================================
git add -A
git diff --cached --quiet || git commit -m "site update: %date% %time%"
git push origin main
if errorlevel 1 echo [WARN] main push failed, continuing...

echo =======================================
echo  2. Clean old cache and generate site...
echo =======================================
if exist "resources" rmdir /s /q "resources"
if exist "public" rmdir /s /q "public"
"%HUGO_PATH%\hugo.exe" --gc
if errorlevel 1 (
    echo [ERROR] Hugo build failed!
    pause
    exit /b 1
)
if not exist "public\index.html" (
    echo [ERROR] public\index.html not found!
    pause
    exit /b 1
)

echo =======================================
echo  3. Deploy to gh-pages branch...
echo =======================================
cd /d "%~dp0public"
git init
git remote remove origin 2>nul
git remote add origin %REPO_URL%
git add -A
git commit -m "deploy: %date% %time%"
git push -f origin HEAD:gh-pages
if errorlevel 1 (
    echo [ERROR] gh-pages push failed!
    pause
    exit /b 1
)
cd ..

echo =======================================
echo  Done! Site deployed.
echo =======================================
pause
