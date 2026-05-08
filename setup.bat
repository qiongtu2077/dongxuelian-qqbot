@echo off
set PATH=C:\Program Files\nodejs;C:\Users\Lenovo\AppData\Roaming\npm;%PATH%

cd /d E:\莲莲Bot

echo === Step 1: npm init ===
call npm init -y

echo === Step 2: Install Koishi + OneBot adapter ===
call npm install koishi
call npm install @koishijs/plugin-adapter-onebot

echo === Step 3: Create directories ===
mkdir data 2>nul
mkdir plugins 2>nul

echo.
echo ======== 部署完成 ========
echo Node.js:
call node -v
call npm -v
echo.
echo 下一步：创建 koishi.yml 配置文件
pause
