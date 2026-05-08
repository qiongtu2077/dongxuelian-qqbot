@echo off
set PATH=C:\Program Files\nodejs;%PATH%
cd /d E:\莲莲Bot

echo === 1. 复制插件到 node_modules ===
for /d %%d in (packages\koishi-plugin-*) do (
    call xcopy /s /e /i /y %%d\node_modules\koishi-plugin-%%~nd\ 2>nul
    call xcopy /s /e /i /y %%d node_modules\%%~nd\
)
echo 插件复制完成

echo === 2. 创建数据目录 ===
if not exist data mkdir data

echo === 3. 修改 AI 插件路径为 Windows 兼容 ===
powershell -Command "(Get-Content node_modules\koishi-plugin-dongxuelian-ai\lib\index.js) -replace '/root/koishi-app/data', 'data' | Set-Content node_modules\koishi-plugin-dongxuelian-ai\lib\index.js"
echo AI插件路径已更新

echo === 4. 创建 koishi.yml ===
(
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
) > koishi.yml
echo koishi.yml 已创建

echo === 5. 创建 AI 占位配置文件 ===
echo 请在此文件写入你的 API Key > data\ai-openai-key.txt
echo qwen-plus > data\ai-model.txt
echo https://dashscope.aliyuncs.com/compatible-mode/v1 > data\ai-base-url.txt
echo AI配置已创建

echo.
echo ======== 部署完成 ========
echo.
echo 还需要做以下几步：
echo 1. 编辑 koishi.yml，把 "你的QQ号" 换成机器人QQ号
echo 2. 编辑 data\ai-openai-key.txt，换成真实的 API Key
echo 3. 启动 NapCat（QQ登录层）
echo 4. 在 E:\莲莲Bot 目录执行: node .
echo.
pause
