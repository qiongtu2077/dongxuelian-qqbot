@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo === 构建莲莲 Bot Windows 部署器 ===

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js。请先安装 Node.js LTS。
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo 未检测到 npm，请检查 Node.js 安装。
  pause
  exit /b 1
)

echo 安装部署器依赖...
call npm --prefix local-deployer install
if errorlevel 1 exit /b 1

echo 构建 Dashboard 前端...
call npm --prefix packages\koishi-plugin-dashboard\frontend install
if errorlevel 1 exit /b 1
call npm --prefix packages\koishi-plugin-dashboard\frontend run build
if errorlevel 1 exit /b 1

echo 打包 Windows 部署器...
call npm --prefix local-deployer run release:win
if errorlevel 1 exit /b 1

echo.
echo 构建完成，产物在 local-deployer\dist 或 local-deployer\release。
pause
