@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo === 莲莲 Bot Windows 本地部署器 ===

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js。请先安装 Node.js LTS，然后重新双击本文件。
  echo 下载地址: https://nodejs.org/
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo 未检测到 npm，请检查 Node.js 安装。
  pause
  exit /b 1
)

if not exist local-deployer\node_modules (
  echo 首次运行，正在安装本地部署器依赖...
  call npm --prefix local-deployer install
  if errorlevel 1 (
    echo 依赖安装失败。
    pause
    exit /b 1
  )
)

echo 正在启动部署器窗口...
call npm --prefix local-deployer run start
pause
