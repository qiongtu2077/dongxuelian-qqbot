@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "TARGET_DIR=%~1"
if "%TARGET_DIR%"=="" set "TARGET_DIR=%SCRIPT_DIR%"
for %%I in ("%TARGET_DIR%") do set "TARGET_DIR=%%~fI"

set "NODE_DIR=C:\Program Files\nodejs"
if exist "%NODE_DIR%\node.exe" set "PATH=%NODE_DIR%;%PATH%"

echo === 本地部署目录 ===
echo %TARGET_DIR%
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo 未找到 node.exe，请先安装 Node.js 20 或将 node 加入 PATH。
    pause
    exit /b 1
)

if not exist "%SCRIPT_DIR%packages" (
    echo 未找到 packages 目录，请在项目根目录运行本脚本。
    pause
    exit /b 1
)

if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"
if not exist "%TARGET_DIR%\node_modules" mkdir "%TARGET_DIR%\node_modules"
if not exist "%TARGET_DIR%\data" mkdir "%TARGET_DIR%\data"

echo === 1. 复制插件到 node_modules ===
for /d %%D in ("%SCRIPT_DIR%packages\koishi-plugin-*") do (
    set "PKG_NAME=%%~nxD"
    echo 复制 !PKG_NAME!
    if exist "%TARGET_DIR%\node_modules\!PKG_NAME!" rmdir /s /q "%TARGET_DIR%\node_modules\!PKG_NAME!"
    xcopy /s /e /i /y "%%D" "%TARGET_DIR%\node_modules\!PKG_NAME!" >nul
)
echo 插件复制完成
echo.

echo === 2. 创建 koishi.yml ===
if not exist "%TARGET_DIR%\koishi.yml" (
    > "%TARGET_DIR%\koishi.yml" (
        echo selfUrl: http://localhost:5140
        echo port: 5140
        echo plugins:
        echo   adapter-onebot:
        echo     protocol: ws-reverse
        echo     selfId: "你的QQ号"
        echo     endpoint: ws://127.0.0.1:8080/onebot/v11/ws
        echo   group-name-at: {}
        echo   dongxuelian-help: {}
        echo   dongxuelian-ai: {}
    )
    echo koishi.yml 已创建
) else (
    echo koishi.yml 已存在，跳过覆盖
)
echo.

echo === 3. 创建 AI 占位配置文件 ===
if not exist "%TARGET_DIR%\data\ai-openai-key.txt" echo 请在此文件写入你的 API Key> "%TARGET_DIR%\data\ai-openai-key.txt"
if not exist "%TARGET_DIR%\data\ai-model.txt" echo qwen-plus> "%TARGET_DIR%\data\ai-model.txt"
if not exist "%TARGET_DIR%\data\ai-provider.txt" echo dashscope> "%TARGET_DIR%\data\ai-provider.txt"
if not exist "%TARGET_DIR%\data\ai-base-url.txt" echo https://dashscope.aliyuncs.com/compatible-mode/v1> "%TARGET_DIR%\data\ai-base-url.txt"
echo AI 配置已检查
echo.

echo === 4. 创建带数据目录环境变量的启动脚本 ===
> "%TARGET_DIR%\start-local.bat" (
    echo @echo off
    echo setlocal
    echo cd /d "%%~dp0"
    echo set "DONGXUELIAN_AI_DATA_DIR=%%~dp0data"
    echo set "KOISHI_DIR=%%~dp0"
    echo node .
)
echo start-local.bat 已创建
echo.

echo ======== 部署完成 ========
echo 1. 编辑 %TARGET_DIR%\koishi.yml，把 "你的QQ号" 换成机器人 QQ 号
echo 2. 编辑 %TARGET_DIR%\data\ai-openai-key.txt，换成真实 API Key
echo 3. 启动 NapCat 并完成 QQ 登录
echo 4. 执行 %TARGET_DIR%\start-local.bat 启动 Koishi
echo.
pause
