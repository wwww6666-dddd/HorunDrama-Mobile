# 给 runtime-stage 追加 x86_64 原生库（在 prepare-runtime.ps1 之后执行）。
# 依赖：.tmp\nodejs-lts_x86_64.deb、.tmp\x86-libs\*.deb、.tmp\ffmpeg_android_x86_64_mini.tar.gz
# 输出：.tmp\runtime-stage\jniLibs\x86_64\lib*.so
param([switch]$SkipFfmpeg)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$tmp = Join-Path $root '.tmp'
$stage = Join-Path $tmp 'runtime-stage'
$assets = Join-Path $stage 'assets'
$jni = Join-Path $stage 'jniLibs\x86_64'
$nodeDeb = Join-Path $tmp 'nodejs-lts_x86_64.deb'
$fftar = Join-Path $tmp 'ffmpeg_android_x86_64_mini.tar.gz'
$libDebs = Join-Path $tmp 'x86-libs'
$libRoot = Join-Path $tmp 'x86-libs\extract'
$nodeRoot = Join-Path $tmp 'node-pkg-x86_64'
$ffdir = Join-Path $tmp 'ffmpeg-unzip-x86_64'
$py = 'C:\Users\31511\AppData\Local\Doubao\User Data\sandbox_runtime\bases\fa694f517e5995233c80a9a8db5212c2\python\python.exe'

$debs = @(
  'libc++_30_x86_64.deb',
  'libicu_79.1_x86_64.deb',
  'openssl_3.6.5_x86_64.deb',
  'c-ares_1.34.9_x86_64.deb',
  'libsqlite_3.54.1-1_x86_64.deb',
  'zlib_1.4_x86_64.deb'
)
foreach ($name in $debs) {
  $p = Join-Path $libDebs $name
  if (-not (Test-Path $p) -or (Get-Item $p).Length -lt 50KB) { throw "缺少 x86_64 依赖包: $p" }
}
$needed = @($nodeDeb, $py, (Join-Path $assets 'web'), (Join-Path $assets 'core'), (Join-Path $assets 'runtime\cacert.pem'))
if (-not $SkipFfmpeg) { $needed += $fftar }
foreach ($need in $needed) {
  if (-not (Test-Path $need)) { throw "缺少 x86_64 运行时素材: $need" }
}
if ((Get-Item $nodeDeb).Length -lt 5MB) { throw "Node 包不完整: $nodeDeb" }

Remove-Item -Recurse -Force $jni, $libRoot, $nodeRoot, $ffdir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $jni, $libRoot | Out-Null

Write-Host '[1/5] 解包 x86_64 依赖库'
foreach ($name in $debs) {
  $dest = Join-Path $libRoot ($name -replace '_.*$', '')
  & $py (Join-Path $PSScriptRoot 'extract-deb.py') (Join-Path $libDebs $name) $dest
  if ($LASTEXITCODE -ne 0) { throw "解包失败: $name" }
}

Write-Host '[2/5] 解包 x86_64 Node'
& $py (Join-Path $PSScriptRoot 'extract-deb.py') $nodeDeb $nodeRoot
if ($LASTEXITCODE -ne 0) { throw '解包 x86_64 Node 失败' }
$node = Get-ChildItem $nodeRoot -Recurse -File -Filter 'node' | Where-Object { $_.DirectoryName -match '\\bin$' } | Select-Object -First 1
if (-not $node -or $node.Length -lt 10MB) { throw "x86_64 Node 解包失败: $node" }
Copy-Item $node.FullName (Join-Path $jni 'libnode.so') -Force

function Copy-Lib([string]$name) {
  $candidate = Get-ChildItem $libRoot -Recurse -File | Where-Object { $_.Name -eq $name -and $_.Length -gt 30KB } |
    Select-Object -First 1
  if (-not $candidate) {
    $stem = $name -replace '\.so$', ''
    $candidate = Get-ChildItem $libRoot -Recurse -File |
      Where-Object { $_.Name -like "$stem.so.*" -and $_.Length -gt 30KB } |
      Sort-Object Length -Descending | Select-Object -First 1
  }
  if (-not $candidate) { throw "x86_64 库缺失: $name" }
  Copy-Item $candidate.FullName (Join-Path $jni $name) -Force
  Write-Host "  $name <- $($candidate.Name)"
}

Write-Host '[3/5] 复制依赖库'
foreach ($name in @('libc++_shared.so', 'libcares.so', 'libsqlite3.so', 'libcrypto.so', 'libssl.so', 'libicudata.so', 'libicui18n.so', 'libicuuc.so', 'libz.so')) {
  Copy-Lib $name
}

Write-Host '[4/5] 改 ELF 动态链接信息'
& $py (Join-Path $PSScriptRoot 'patch_elf.py') $jni
if ($LASTEXITCODE -ne 0) { throw 'x86_64 ELF 补丁失败' }

Write-Host '[5/5] 解压并放置 x86_64 ffmpeg'
if ($SkipFfmpeg) {
  Write-Host '  跳过（-SkipFfmpeg）：仅用于先验证 Node/WebView，最终包必须补回'
} else {
  New-Item -ItemType Directory -Force -Path $ffdir | Out-Null
  & 'C:\Windows\System32\tar.exe' -xzf $fftar -C $ffdir
  if ($LASTEXITCODE -ne 0) { throw '解压 x86_64 ffmpeg 失败' }
  $ff = Get-ChildItem $ffdir -Recurse -File | Where-Object { $_.Name -eq 'ffmpeg' } | Select-Object -First 1
  if (-not $ff -or $ff.Length -lt 5MB) { throw "x86_64 ffmpeg 不完整: $ff" }
  Copy-Item $ff.FullName (Join-Path $jni 'libffmpeg.so') -Force
}

$size = (Get-ChildItem $jni -File | Measure-Object Length -Sum).Sum
Write-Host "x86_64 jniLibs: $([math]::Round($size/1MB,1)) MB"
Get-ChildItem $jni -File | Select-Object Name, @{n='MB'; e={[math]::Round($_.Length/1MB,2)}}
