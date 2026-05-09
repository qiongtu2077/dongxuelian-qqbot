@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo === 卸载莲莲 Bot Windows 本地部署器 ===
echo 将关闭本目录启动的 Electron/Dashboard/Koishi 进程，并清理依赖与构建产物。
echo 默认不会删除 data 和 runtime，避免误删 Key、记忆、日志和 NapCat 文件。
echo.
set /p CLEAN_DATA=是否同时删除 data、runtime、koishi.yml、start-local.bat？输入 YES 才会彻底清理:

node local-deployer\scripts\uninstall.cjs %CLEAN_DATA%

echo.
echo 卸载清理完成。
pause
