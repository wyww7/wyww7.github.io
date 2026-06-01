@echo off
set HUGO_PATH=C:\software\other\hugo\hugo_extended_withdeploy_0.161.1_windows-amd64
set REPO_URL=https://github.com/wyww7/wyww7.github.io
cd /d "%~dp0"

echo =======================================
echo  1. Backup source code to main branch...
echo =======================================
git add -A
git commit -m "site update: %date% %time%"
git push origin main

echo =======================================
echo  2. Clean old cache and generate site...
echo =======================================
"%HUGO_PATH%\hugo.exe" --gc --cleanDestinationDir

echo =======================================
echo  3. Deploy to gh-pages branch...
echo =======================================
cd public
git init
git remote add origin %REPO_URL%
git add -A
git commit -m "deploy: %date% %time%"
git push -f origin HEAD:gh-pages
cd ..

echo =======================================
echo  Done! Source backed up and site deployed.
echo =======================================
pause
