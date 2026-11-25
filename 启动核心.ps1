# 启动手机端核心（跑在电脑上）
# 双击或用 PowerShell 执行：powershell -ExecutionPolicy Bypass -File .\启动核心.ps1
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# 缓存、临时文件都放 D 盘，别占 C 盘
$env:TEMP = Join-Path $root '.tmp\temp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null

if (Get-Command node -ErrorAction SilentlyContinue) {
  $node = 'node'
} elseif (Test-Path 'C:\Program Files\nodejs\node.exe') {
  $node = 'C:\Program Files\nodejs\node.exe'
} else {
  throw '没找到 Node.js，先装 Node 22+'
}

# 前端产物不存在就先构建
if (-not (Test-Path (Join-Path $root 'apps\mobile-web\dist\index.html'))) {
  Write-Host '首次启动：正在构建手机端前端…'
  & pnpm --filter '@horun/mobile-web' run build
}

$env:HORUN_PORT = '5881'
Write-Host '手机端核心启动中，启动日志里会打印「手机端访问地址」。按 Ctrl+C 停止。'
& $node (Join-Path $root 'apps\mobile-core\src\index.ts')
