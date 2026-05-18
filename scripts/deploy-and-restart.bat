@echo off
REM 同步文件并重启服务器 Bot
REM 用法: scripts\deploy-and-restart.bat root@服务器IP [文件名...]
REM 或先 set DEPLOY_SERVER=root@服务器IP，再运行 scripts\deploy-and-restart.bat [文件名...]
REM 如果不传文件名，默认同步所有 lib/ + templates/

setlocal enabledelayedexpansion

set "SERVER=%DEPLOY_SERVER%"
if not "%~1"=="" (
  echo %~1 | findstr /r "^[A-Za-z0-9._-][A-Za-z0-9._-]*@.*" >nul
  if !errorlevel! equ 0 (
    set "SERVER=%~1"
    shift /1
  )
)
if "%SERVER%"=="" (
  echo 用法: scripts\deploy-and-restart.bat root@服务器IP [文件名...]
  echo 或先 set DEPLOY_SERVER=root@服务器IP，再运行 scripts\deploy-and-restart.bat [文件名...]
  exit /b 1
)

set "APP_DIR=%DEPLOY_APP_DIR%"
if "%APP_DIR%"=="" set "APP_DIR=/root/koishi-app"
set "REMOTE_DIR=%APP_DIR%/packages/koishi-plugin-daily-report"

if "%1"=="" (
  echo 同步全部 lib/ + templates/ ...
  scp packages/koishi-plugin-daily-report/lib/*.js "!SERVER!:%REMOTE_DIR%/lib/"
  scp packages/koishi-plugin-daily-report/templates/*.html "!SERVER!:%REMOTE_DIR%/templates/"
) else (
  goto copy_files
)

goto restart_bot

:copy_files
if "%~1"=="" goto restart_bot
echo 同步 %~1 ...
scp "%~1" "!SERVER!:%REMOTE_DIR%/%~1"
if errorlevel 1 exit /b %errorlevel%
shift /1
goto copy_files

:restart_bot
REM 执行远程重启脚本
echo 重启 bot ...
ssh "!SERVER!" "bash %APP_DIR%/restart.sh"
