@echo off
:: 强制 CMD 窗口使用 UTF-8 编码，彻底解决乱码问题
chcp 65001 >nul

:: 【核心配置】请确保下面这个路径是你 hugo.exe 所在的文件夹路径
set HUGO_PATH=C:\software\other\hugo\hugo_extended_withdeploy_0.161.1_windows-amd64

:: 强行将工作目录切换到当前脚本所在的 dev 目录
cd /d "%~dp0"

echo =======================================
echo  1. 开始备份博客源码到 main 分支...
echo =======================================
git add .
git commit -m "site update: %date% %time%"
git push origin main

echo =======================================
echo  2. 正在清理旧缓存并生成最新静态网页...
echo =======================================
:: 使用绝对路径调用 hugo，彻底解决找不到命令的问题
"%HUGO_PATH%\hugo.exe" --gc --cleanDestinationDir

echo =======================================
echo  3. 开始推送网页到 gh-pages 分支...
echo =======================================
cd public
git add .
git commit -m "deploy: %date% %time%"
git push origin gh-pages --force
cd ..

echo =======================================
echo  🎉 恭喜！全套源码备份与网页部署已全部完成！
echo =======================================
pause