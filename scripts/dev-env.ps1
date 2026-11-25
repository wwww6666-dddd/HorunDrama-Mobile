# 手机端工程环境：把 npm / pnpm 缓存全部留在 D 盘，并补齐构建所需的 PATH。
$repo = 'D:\红果短剧手机端'
$env:TEMP = Join-Path $repo '.tmp\temp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
$env:ANDROID_HOME = 'D:\horun-android\android-sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:ANDROID_AVD_HOME = 'D:\horun-android\.android\avd'
foreach ($p in @("$env:ANDROID_HOME\platform-tools", "$env:ANDROID_HOME\build-tools\36.1.0", 'C:\WINDOWS\System32', 'D:\git\Git\cmd')) {
  if ((Test-Path $p) -and ($env:PATH -notlike "*$p*")) { $env:PATH = "$p;$env:PATH" }
}
Write-Output "[env] repo = $repo"
Write-Output "[env] TEMP = $env:TEMP"
