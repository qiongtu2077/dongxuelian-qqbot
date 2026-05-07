@echo off
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0packages\desktop-app\main.js"
