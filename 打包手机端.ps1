# 打包手机端：先构建网页，再出 APK
# 用法：powershell -ExecutionPolicy Bypass -File .\打包手机端.ps1
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$env:TEMP = Join-Path $root '.tmp\temp'
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null

Write-Host '=== 1/2 构建手机端网页 ==='
Push-Location $root
& pnpm --filter '@horun/mobile-web' run build
Pop-Location

Write-Host '=== 2/2 构建 APK ==='
& powershell -ExecutionPolicy Bypass -File (Join-Path $root 'android\build.ps1')

Write-Host ''
Write-Host 'APK 在 android\out\HorunDrama-mobile-1.0.0.apk'
Write-Host '手机插上 USB（开 USB 调试）后可执行：.\安装到手机.ps1'
