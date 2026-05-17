@echo off
setlocal enabledelayedexpansion

set SERVER=root@YOUR_SERVER_IP
set FRONTEND_DIR=packages\koishi-plugin-dashboard\frontend
set REMOTE_DIR=/root/koishi-app/packages/koishi-plugin-dashboard/frontend

echo === Build frontend ===
cd /d "%~dp0\..\packages\koishi-plugin-dashboard\frontend"
call npm run build
if %errorlevel% neq 0 exit /b %errorlevel%
cd /d "%~dp0\.."

echo === Deploy dist ===
scp %FRONTEND_DIR%\dist\index.html %SERVER%:%REMOTE_DIR%/dist/index.html
scp %FRONTEND_DIR%\dist\assets\* %SERVER%:%REMOTE_DIR%/dist/assets/

echo === Clean old assets ===
ssh %SERVER% "cd %REMOTE_DIR%/dist/assets && ls -t | tail -n +3 | xargs rm -f 2>/dev/null; echo done"

echo === Sync frontend src ===
scp %FRONTEND_DIR%\src\*.css %SERVER%:%REMOTE_DIR%/src/ 2>nul
scp %FRONTEND_DIR%\src\*.vue %SERVER%:%REMOTE_DIR%/src/ 2>nul
scp %FRONTEND_DIR%\src\*.js %SERVER%:%REMOTE_DIR%/src/ 2>nul
scp %FRONTEND_DIR%\src\components\*.vue %SERVER%:%REMOTE_DIR%/src/components/ 2>nul

echo.
echo === Done ===
echo.
