# 组装独立 APK 的内置运行时：Node、依赖库、静态 ffmpeg、核心与前端。
# 用法：powershell -ExecutionPolicy Bypass -File .\android\prepare-runtime.ps1
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$tmp = Join-Path $root '.tmp'
$out = Join-Path $tmp 'runtime-stage'
$assets = Join-Path $out 'assets'
$jni = Join-Path $out 'jniLibs\arm64-v8a'
$node = Join-Path $tmp 'node-pkg\data\data\com.termux\files\usr\bin\node'
$libRoot = Join-Path $tmp 'runtime-root\data\data\com.termux\files\usr\lib'
$cert = Join-Path $tmp 'runtime-root\data\data\com.termux\files\usr\etc\tls\cert.pem'
$ffzip = Join-Path $tmp 'ffmpeg-static-arm64.zip'
$ffmini = Join-Path $tmp 'ffmpeg-mini-aarch64.tar.gz'
$py = 'C:\Users\31511\AppData\Local\Doubao\User Data\sandbox_runtime\bases\fa694f517e5995233c80a9a8db5212c2\python\python.exe'

foreach ($need in @($node, $libRoot, $cert, (Join-Path $root 'apps\mobile-web\dist\index.html'), (Join-Path $root 'apps\mobile-core\src\index.ts'))) {
  if (-not (Test-Path $need)) { throw "缺少运行时素材: $need" }
}
if (-not (Test-Path $ffmini) -and -not (Test-Path $ffzip)) {
  throw '缺少 ffmpeg：需要 .tmp\ffmpeg-mini-aarch64.tar.gz 或 .tmp\ffmpeg-static-arm64.zip'
}
if ((Test-Path $ffzip) -and (Get-Item $ffzip).Length -lt 60MB -and -not (Test-Path $ffmini)) {
  throw "ffmpeg 压缩包还没下完：$([math]::Round((Get-Item $ffzip).Length/1MB,1)) MB"
}

Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $jni, (Join-Path $assets 'core'), (Join-Path $assets 'web'), (Join-Path $assets 'runtime') | Out-Null

Write-Host '[1/5] 复制 Node 与依赖库'
Copy-Item $node (Join-Path $jni 'libnode.so') -Force
$libs = @(
  'libc++_shared.so',
  'libcares.so',
  'libsqlite3.so',
  'libcrypto.so',
  'libssl.so',
  'libicudata.so',
  'libicui18n.so',
  'libicuuc.so',
  'libz.so'
)
foreach ($name in $libs) {
  $from = Join-Path $libRoot $name
  if (-not (Test-Path $from)) { throw "依赖库缺失: $name" }
  Copy-Item $from (Join-Path $jni $name) -Force
}

Write-Host '[2/5] 改 ELF 动态链接信息'
& $py (Join-Path $root 'android\patch_elf.py') $jni
if ($LASTEXITCODE -ne 0) { throw 'ELF 补丁失败' }

Write-Host '[3/5] 解压 ffmpeg'
$ffdir = Join-Path $tmp 'ffmpeg-unzip'
Remove-Item -Recurse -Force $ffdir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $ffdir | Out-Null
if (Test-Path $ffmini) {
  # pwsh 的 PATH 有时不含 System32，直接写命令名会找不到 tar；按 PATH → System32 顺序兜底
  $tarCmd = Get-Command tar -ErrorAction SilentlyContinue
  $tarExe = if ($null -ne $tarCmd) { $tarCmd.Source } elseif (Test-Path "$env:SystemRoot\System32\tar.exe") { "$env:SystemRoot\System32\tar.exe" } else { '' }
  if ($tarExe -eq '') { throw '找不到 tar.exe，无法解压 mini ffmpeg' }
  & $tarExe -xzf $ffmini -C $ffdir
  if ($LASTEXITCODE -ne 0) { throw '解压 mini ffmpeg 失败' }
} else {
  Expand-Archive -LiteralPath $ffzip -DestinationPath $ffdir -Force
}
$ff = Get-ChildItem $ffdir -Recurse -File | Where-Object { $_.Name -eq 'ffmpeg' -or $_.Name -eq 'ffmpeg.exe' } | Select-Object -First 1
if ($null -eq $ff) { throw '压缩包里没有 ffmpeg 可执行文件' }
if ($ff.Length -lt 5MB) { throw "ffmpeg 文件过小: $($ff.Length)" }
Copy-Item $ff.FullName (Join-Path $jni 'libffmpeg.so') -Force
& $py -c "import sys; sys.path.insert(0,r'D:\红果短剧手机端\.tmp\pylibs'); from elftools.elf.elffile import ELFFile; p=r'$((Join-Path $jni 'libffmpeg.so'))'; e=ELFFile(open(p,'rb')); print('ffmpeg:', e['e_machine'], e['e_type'], e['e_entry'])"
if ($LASTEXITCODE -ne 0) { throw 'ffmpeg ELF 检查失败' }

Write-Host '[4/5] 复制核心与前端'
Copy-Item (Join-Path $root 'apps\mobile-core\src') (Join-Path $assets 'core\src') -Recurse -Force
$pkg = '{ "name": "@horun/mobile-core", "private": true, "type": "module" }'
Set-Content -Path (Join-Path $assets 'core\package.json') -Value $pkg -Encoding Ascii
$sdk = Join-Path $root 'apps\mobile-core\node_modules\openhongguo'
if (-not (Test-Path $sdk)) { throw '缺少 openhongguo 依赖，请先在 apps\mobile-core 执行 npm install' }
Copy-Item $sdk (Join-Path $assets 'core\node_modules\openhongguo') -Recurse -Force
Copy-Item (Join-Path $root 'apps\mobile-web\dist\*') (Join-Path $assets 'web') -Recurse -Force
Copy-Item $cert (Join-Path $assets 'runtime\cacert.pem') -Force

Write-Host '[5/5] 汇总'
$jniSize = (Get-ChildItem $jni -File | Measure-Object Length -Sum).Sum
$assetSize = (Get-ChildItem $assets -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host "jniLibs: $([math]::Round($jniSize/1MB,1)) MB"
Write-Host "assets:  $([math]::Round($assetSize/1MB,1)) MB"
Write-Host "输出:    $out"
