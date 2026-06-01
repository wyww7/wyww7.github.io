@echo off

:: Deploy script for Hugo blog - GitHub Pages
set HUGO_PATH=C:\software\other\hugo\hugo_extended_withdeploy_0.161.1_windows-amd64

cd /d "%~dp0"

echo =======================================
echo  1. Backup source code to main branch...
echo =======================================
git add -A
git commit -m "site update: %date% %time%"
git push origin main

echo =======================================
echo  2. Clean old cache & generate site...
echo =======================================
"%HUGO_PATH%\hugo.exe" --gc --cleanDestinationDir

echo =======================================
echo  3. Deploy to gh-pages branch...
echo =======================================
cd public
git add -A
git commit -m "deploy: %date% %time%"
git push origin gh-pages --force
cd ..

echo =======================================
echo  Done! Source backed up & site deployed.
echo =======================================
pause
