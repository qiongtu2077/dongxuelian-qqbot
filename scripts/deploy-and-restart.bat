@echo off
REM 同步文件并重启服务器 Bot
REM 用法: scripts\deploy-and-restart.bat [文件名...]
REM 如果不传文件名，默认同步所有 lib/ + templates/

setlocal enabledelayedexpansion

if "%DEPLOY_SERVER%"=="" ( set SERVER=root@YOUR_SERVER_IP ) else ( set SERVER=%DEPLOY_SERVER% )
if "%REMOTE_DIR%"=="" ( set REMOTE_DIR=/root/koishi-app/packages/koishi-plugin-daily-report ) else ( set REMOTE_DIR=%REMOTE_DIR% )

if "%1"=="" (
  echo 同步全部 lib/ + templates/ ...
  scp packages/koishi-plugin-daily-report/lib/*.js !SERVER!:%REMOTE_DIR%/lib/
  scp packages/koishi-plugin-daily-report/templates/*.html !SERVER!:%REMOTE_DIR%/templates/
) else (
  for %%f in (%*) do (
    echo 同步 %%f ...
    scp %%f !SERVER!:%REMOTE_DIR%/%%f
  )
)

REM 执行远程重启脚本
echo 重启 bot ...
ssh !SERVER! "bash /root/koishi-app/restart.sh"
