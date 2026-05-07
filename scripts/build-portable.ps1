param(
  [string]$Version = "1.0.0",
  [string]$OutDir = "$PSScriptRoot\..\dist-portable"
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path "$PSScriptRoot\.."
$PortableDir = "$OutDir\lianlian-bot-v$Version"
$ZipFile = "$OutDir\lianlian-bot-v$Version.zip"

Write-Host "=== 构建便携版 v$Version ===" -ForegroundColor Cyan

# 1. 构建前端
Write-Host "[1/7] 构建前端..." -ForegroundColor Yellow
Push-Location "$Root\packages\koishi-plugin-dashboard\frontend"
npm run build
Pop-Location

# 2. 创建便携版目录
Write-Host "[2/7] 创建目录结构..." -ForegroundColor Yellow
if (Test-Path $PortableDir) { Remove-Item $PortableDir -Recurse -Force }
$dirs = @(
  "$PortableDir\resources\app",
  "$PortableDir\resources\dashboard\frontend\dist\assets",
  "$PortableDir\packages"
)
foreach ($d in $dirs) { New-Item -ItemType Directory -Path $d -Force | Out-Null }

# 3. 复制 Electron 运行时
Write-Host "[3/7] 复制 Electron 运行时..." -ForegroundColor Yellow
$electronDist = "$Root\node_modules\electron\dist"
Copy-Item "$electronDist\electron.exe" "$PortableDir\莲莲BOT.exe"
Copy-Item "$electronDist\chrome_*.pak" $PortableDir
Copy-Item "$electronDist\d3dcompiler_47.dll" $PortableDir
Copy-Item "$electronDist\ffmpeg.dll" $PortableDir
Copy-Item "$electronDist\icudtl.dat" $PortableDir
Copy-Item "$electronDist\libEGL.dll" $PortableDir
Copy-Item "$electronDist\libGLESv2.dll" $PortableDir
Copy-Item "$electronDist\resources.pak" $PortableDir
Copy-Item "$electronDist\v8_context_snapshot.bin" $PortableDir
Copy-Item "$electronDist\vk_swiftshader.dll" $PortableDir
Copy-Item "$electronDist\locales" "$PortableDir\locales" -Recurse

# 4. 复制桌面应用代码
Write-Host "[4/7] 复制桌面应用..." -ForegroundColor Yellow
Copy-Item "$Root\packages\desktop-app\main.js" "$PortableDir\resources\app\main.js"
Copy-Item "$Root\packages\desktop-app\preload.js" "$PortableDir\resources\app\preload.js"
Copy-Item "$Root\packages\desktop-app\package.json" "$PortableDir\resources\app\package.json"
Copy-Item "$Root\packages\desktop-app\icon.ico" "$PortableDir\resources\app\icon.ico"

# 5. 复制 Dashboard 后端和前端
Write-Host "[5/7] 复制 Dashboard..." -ForegroundColor Yellow
Copy-Item "$Root\packages\koishi-plugin-dashboard\standalone.js" "$PortableDir\resources\dashboard\standalone.js"
Copy-Item "$Root\packages\koishi-plugin-dashboard\frontend\dist\index.html" "$PortableDir\resources\dashboard\frontend\dist\index.html"
Copy-Item "$Root\packages\koishi-plugin-dashboard\frontend\dist\assets\*" "$PortableDir\resources\dashboard\frontend\dist\assets"

# 6. 复制插件源码（供部署使用）
Write-Host "[6/7] 复制插件源码..." -ForegroundColor Yellow
$pkgs = @(
  "koishi-plugin-dongxuelian-ai",
  "koishi-plugin-dongxuelian-help",
  "koishi-plugin-group-name-at",
  "koishi-plugin-defense",
  "koishi-plugin-local-video-sender",
  "koishi-plugin-group-leave-notice",
  "koishi-plugin-dongxuelian-poke",
  "koishi-plugin-daily-report",
  "koishi-plugin-dashboard"
)
foreach ($pkg in $pkgs) {
  $src = "$Root\packages\$pkg"
  $dst = "$PortableDir\packages\$pkg"
  if (Test-Path $src) {
    Copy-Item $src $dst -Recurse -Exclude "node_modules","data","frontend/node_modules","frontend/dist/assets" -ErrorAction SilentlyContinue
  }
}
# 重新复制 frontend/dist 的 assets（被上面的 exclude 跳过了）
if (Test-Path "$Root\packages\koishi-plugin-dashboard\frontend\dist\assets") {
  New-Item -ItemType Directory -Path "$PortableDir\packages\koishi-plugin-dashboard\frontend\dist\assets" -Force | Out-Null
  Copy-Item "$Root\packages\koishi-plugin-dashboard\frontend\dist\assets\*" "$PortableDir\packages\koishi-plugin-dashboard\frontend\dist\assets"
}
if (Test-Path "$Root\packages\koishi-plugin-dashboard\frontend\dist\index.html") {
  Copy-Item "$Root\packages\koishi-plugin-dashboard\frontend\dist\index.html" "$PortableDir\packages\koishi-plugin-dashboard\frontend\dist\index.html"
}

# 7. 创建启动脚本
Write-Host "[7/7] 创建启动脚本..." -ForegroundColor Yellow
@"
@echo off
start "" "%~dp0莲莲BOT.exe"
"@ | Set-Content "$PortableDir\启动莲莲BOT.bat" -Encoding ASCII

# 8. 嵌入图标
Write-Host "嵌入图标..." -ForegroundColor Yellow
$rcedit = "$Root\node_modules\rcedit\bin\rcedit-x64.exe"
if (Test-Path $rcedit) {
  & $rcedit "$PortableDir\莲莲BOT.exe" --set-icon "$PortableDir\resources\app\icon.ico" 2>$null
}

# 9. 打包 zip
Write-Host "打包 zip..." -ForegroundColor Yellow
if (Test-Path $ZipFile) { Remove-Item $ZipFile -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($PortableDir, $ZipFile)

# 输出
$zipSize = [math]::Round((Get-Item $ZipFile).Length / 1MB, 1)
$dirSize = [math]::Round((Get-ChildItem $PortableDir -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
Write-Host @"
=== 构建完成 ===
便携版目录: $PortableDir ($dirSize MB)
ZIP 文件:    $ZipFile ($zipSize MB)
"@ -ForegroundColor Green
