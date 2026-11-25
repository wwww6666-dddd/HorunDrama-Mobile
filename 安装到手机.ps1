# 把 APK 装到连着的手机（需开 USB 调试）
# 用法：powershell -ExecutionPolicy Bypass -File .\安装到手机.ps1
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$adb = 'D:\Android\Sdk\platform-tools\adb.exe'
$apk = Join-Path $root 'android\out\HorunDrama-mobile-1.0.0.apk'

if (-not (Test-Path $adb)) { throw "找不到 adb：$adb" }
if (-not (Test-Path $apk)) { throw "还没打包，先跑 打包手机端.ps1" }

& $adb devices
$devices = (& $adb devices) | Select-String -Pattern "\sdevice$"
if (-not $devices) { throw '没有检测到手机：插上 USB，打开「开发者选项 → USB 调试」' }

Write-Host "安装 $apk"
& $adb install -r $apk
if ($LASTEXITCODE -ne 0) { throw '安装失败（手机上点允许安装未知来源）' }

Write-Host '启动 App'
& $adb shell monkey -p com.horun.drama -c android.intent.category.LAUNCHER 1 | Out-Null
Write-Host '装好了。第一次打开填电脑上打印的地址（如 192.168.1.23:5881）。'
