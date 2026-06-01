@echo off
chcp 65001 >nul

set HUGO_PATH=C:\software\other\hugo\hugo_extended_withdeploy_0.161.1_windows-amd64

cd /d "%~dp0"

echo =======================================
echo   1. commit and push source to main
echo =======================================
git add .
git diff --cached --quiet || git commit -m "site update: %date% %time%"
git push origin main

echo =======================================
echo   2. generate static site
echo =======================================
"%HUGO_PATH%\hugo.exe" --gc --cleanDestinationDir

echo =======================================
echo   3. push to gh-pages
echo =======================================
cd public
git add .
git diff --cached --quiet || git commit -m "deploy: %date% %time%"
git push origin main:gh-pages --force
cd ..

echo =======================================
echo   Done.
echo =======================================
pause
