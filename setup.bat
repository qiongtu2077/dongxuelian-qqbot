@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo === 莲莲 Bot Windows 本地部署准备 ===
echo 当前目录: %CD%

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装 Node.js LTS 后重新运行。
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo 未检测到 npm，请检查 Node.js 安装。
  pause
  exit /b 1
)

if not exist runtime mkdir runtime
if not exist runtime\downloads mkdir runtime\downloads
if not exist runtime\logs mkdir runtime\logs
if not exist runtime\napcat mkdir runtime\napcat
if not exist data mkdir data

echo.
echo Node.js:
node -v
echo npm:
npm -v

echo.
echo 如需生成 koishi.yml，请打开 Dashboard 的「部署」页填写机器人 QQ 并点击「生成本地配置」。
echo Dashboard 启动: node packages\koishi-plugin-dashboard\standalone.js
echo NapCat 建议解压到 runtime\napcat，OneBot WebSocket 端口使用 8080。
echo.
pause
