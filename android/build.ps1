# 手机端 APK 构建：aapt2 → javac → d8 → zipalign → apksigner（不依赖 Gradle/AGP，离线可重复）
# 用法：powershell -ExecutionPolicy Bypass -File .\android\build.ps1
#
# 注意：aapt2 / apksigner 在 Windows 上不认非 ASCII 路径（本工程目录名是中文），
# 所以先把源码和资源拷到 D:\horun-android\.tmp\horun-mobile-build 这个纯英文路径里再构建，最后把 APK 拷回来。
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$env:TEMP = Join-Path $root '.tmp\temp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
$JDK = 'D:\jdk25\openjdk-25.0.1_windows-x64_bin\jdk-25.0.1'
# aapt2/apksigner 不认中文路径；SDK 实体在工程内，通过 ASCII 联接 D:\horun-android 访问。
$sdkRoot = 'D:\horun-android\android-sdk'
if (-not (Test-Path $sdkRoot)) { $sdkRoot = Join-Path $root 'android-sdk' }
$BT = Join-Path $sdkRoot 'build-tools\36.1.0'
$AJAR = Join-Path $sdkRoot 'platforms\android-36.1\android.jar'
# d8.bat / apksigner.bat 靠 JAVA_HOME 找 java；本机环境变量指向了不存在的目录，这里显式指定
$env:JAVA_HOME = $JDK
$env:PATH = "$JDK\bin;$BT;$env:PATH"

$src = Join-Path $root 'android'
$runtimeStage = Join-Path $root '.tmp\runtime-stage'
$stage = 'D:\horun-android\.tmp\horun-mobile-build'
$work = Join-Path $stage 'work'
$out = Join-Path $root 'android\out'
$apk = Join-Path $work 'HorunDrama-mobile-1.3.1.apk'
$versionCode = 17
$versionName = '1.3.1'

# aapt2 的 --version-code/--version-name 不会覆盖 manifest 里的硬编码值；
# 这里先卡住，避免出现 build.ps1 写 1.1.3、APK 实际还是旧版本（2026-11-25 遇到过）
$manifestText = Get-Content -LiteralPath (Join-Path $src 'AndroidManifest.xml') -Raw
if ($manifestText -notmatch "android:versionCode=`"$versionCode`"" -or $manifestText -notmatch "android:versionName=`"$versionName`"") {
  throw "AndroidManifest.xml 的 versionCode/versionName 与 build.ps1 不一致：需要 versionCode=$versionCode / versionName=$versionName"
}

# 高清取流侧车与 MetaSec 材料（不进 git；构建前放到 .tmp\hgresolve）
$sidecar = Join-Path $root '.tmp\hgresolve'
if (Test-Path $sidecar) {
  foreach ($abi in @('arm64-v8a', 'x86_64')) {
    $lib = Join-Path $sidecar "$abi\libhgresolve.so"
    if (Test-Path $lib) {
      $dst = Join-Path $runtimeStage "jniLibs\$abi"
      New-Item -ItemType Directory -Force -Path $dst | Out-Null
      Copy-Item $lib (Join-Path $dst 'libhgresolve.so') -Force
      Write-Host "  + libhgresolve.so $abi"
    }
  }
  $meta = Join-Path $sidecar 'metasec'
  if ((Test-Path (Join-Path $meta 'image.elf')) -and (Test-Path (Join-Path $meta 'license.txt'))) {
    $dst = Join-Path $runtimeStage 'assets\core\vendor\hgresolve\metasec'
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    Copy-Item (Join-Path $meta 'image.elf') $dst -Force
    Copy-Item (Join-Path $meta 'license.txt') $dst -Force
    Write-Host '  + MetaSec 材料'
  }
}

foreach ($need in @("$JDK\bin\javac.exe", "$BT\aapt2.exe", "$BT\d8.bat", "$BT\apksigner.bat", "$BT\zipalign.exe", $AJAR, (Join-Path $runtimeStage 'assets'), (Join-Path $runtimeStage 'jniLibs'))) {
  if (-not (Test-Path $need)) { throw "缺少构建素材: $need（先跑 .\android\prepare-runtime.ps1）" }
}
foreach ($abi in @('arm64-v8a', 'x86_64')) {
  $nodeLib = Join-Path $runtimeStage "jniLibs\$abi\libnode.so"
  if (-not (Test-Path $nodeLib)) { throw "缺少 $abi 的 libnode.so（先跑 .\android\prepare-runtime-x86.ps1）" }
}

Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $work, (Join-Path $work 'gen'), (Join-Path $work 'classes'), (Join-Path $work 'dex'), $out | Out-Null
Copy-Item (Join-Path $src 'res') (Join-Path $stage 'res') -Recurse -Force
Copy-Item (Join-Path $src 'src') (Join-Path $stage 'src') -Recurse -Force
Copy-Item (Join-Path $src 'AndroidManifest.xml') (Join-Path $stage 'AndroidManifest.xml') -Force
Copy-Item (Join-Path $src 'debug.keystore') $stage -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $runtimeStage 'assets') (Join-Path $stage 'assets') -Recurse -Force
Copy-Item (Join-Path $runtimeStage 'jniLibs') (Join-Path $stage 'jniLibs') -Recurse -Force

Write-Host '[1/8] 生成 BuildConfig'
$bcDir = Join-Path $work 'gen\com\horun\drama'
New-Item -ItemType Directory -Force -Path $bcDir | Out-Null
$bc = @"
package com.horun.drama;

public final class BuildConfig {
    public static final boolean DEBUG = false;
    public static final String APPLICATION_ID = "com.horun.drama";
    public static final int VERSION_CODE = $versionCode;
    public static final String VERSION_NAME = "$versionName";
}
"@
Set-Content -Path (Join-Path $bcDir 'BuildConfig.java') -Value $bc -Encoding Ascii

Write-Host '[2/8] 编译资源'
& "$BT\aapt2.exe" compile --dir (Join-Path $stage 'res') -o (Join-Path $work 'res.zip')
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile 失败' }

Write-Host '[3/8] 链接资源与清单'
& "$BT\aapt2.exe" link -o (Join-Path $work 'base.apk') `
  --manifest (Join-Path $stage 'AndroidManifest.xml') `
  --java (Join-Path $work 'gen') `
  --min-sdk-version 24 --target-sdk-version 35 `
  --version-code $versionCode --version-name $versionName `
  --auto-add-overlay `
  -I $AJAR `
  (Join-Path $work 'res.zip')
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link 失败' }

Write-Host '[4/8] 编译 Java'
$sources = @()
$sources += Get-ChildItem (Join-Path $stage 'src') -Recurse -Filter *.java | Select-Object -ExpandProperty FullName
$sources += Get-ChildItem (Join-Path $work 'gen') -Recurse -Filter *.java | Select-Object -ExpandProperty FullName
$srcList = Join-Path $work 'sources.txt'
Set-Content -Path $srcList -Value $sources -Encoding ascii
& "$JDK\bin\javac.exe" --release 11 -encoding UTF-8 -nowarn -cp $AJAR -d (Join-Path $work 'classes') "@$srcList"
if ($LASTEXITCODE -ne 0) { throw 'javac 失败' }

Write-Host '[5/8] dex'
$classes = Get-ChildItem (Join-Path $work 'classes') -Recurse -Filter *.class | Select-Object -ExpandProperty FullName
& "$BT\d8.bat" --release --min-api 24 --lib $AJAR --output (Join-Path $work 'dex') @classes
if ($LASTEXITCODE -ne 0) { throw 'd8 失败' }

Write-Host '[6/8] 打包 classes.dex 与原生库'
$unaligned = Join-Path $work 'unaligned.apk'
Copy-Item (Join-Path $work 'base.apk') $unaligned -Force
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($unaligned, 'Update')
try {
  $entry = $zip.CreateEntry('classes.dex', [System.IO.Compression.CompressionLevel]::Optimal)
  $dex = Join-Path $work 'dex\classes.dex'
  $bytes = [System.IO.File]::ReadAllBytes($dex)
  $s = $entry.Open()
  $s.Write($bytes, 0, $bytes.Length)
  $s.Dispose()

  foreach ($abiDir in Get-ChildItem (Join-Path $stage 'jniLibs') -Directory) {
    foreach ($lib in Get-ChildItem $abiDir.FullName -Filter *.so -File) {
      $name = "lib/$($abiDir.Name)/$($lib.Name)"
      $entry = $zip.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
      $s = $entry.Open()
      $buf = [System.IO.File]::ReadAllBytes($lib.FullName)
      $s.Write($buf, 0, $buf.Length)
      $s.Dispose()
      Write-Host "  + $name $([math]::Round($buf.Length/1MB,1)) MB"
    }
  }

  # aapt2 的 -A 在 Windows 上会把 asset 条目写成反斜杠（assets\core\...），
  # AssetManager 列不出目录，NodeCore 释放运行时直接报 "core"。
  # 这里不用 -A，自己按 POSIX 路径（assets/core/...）写入，保证 list/open 都能用。
  $assetRoot = Join-Path $stage 'assets'
  $assetCount = 0
  foreach ($a in Get-ChildItem $assetRoot -Recurse -File) {
    $rel = $a.FullName.Substring($assetRoot.Length + 1).Replace('\', '/')
    $entry = $zip.CreateEntry("assets/$rel", [System.IO.Compression.CompressionLevel]::Optimal)
    $s = $entry.Open()
    $buf = [System.IO.File]::ReadAllBytes($a.FullName)
    $s.Write($buf, 0, $buf.Length)
    $s.Dispose()
    $assetCount++
  }
  Write-Host "  + assets/  $assetCount files"
} finally {
  $zip.Dispose()
}

Write-Host '[7/8] zipalign'
$aligned = Join-Path $work 'aligned.apk'
& "$BT\zipalign.exe" -f -p 4 $unaligned $aligned
if ($LASTEXITCODE -ne 0) { throw 'zipalign 失败' }

Write-Host '[8/8] 签名'
$ks = Join-Path $stage 'debug.keystore'
if (-not (Test-Path $ks)) {
  & "$JDK\bin\keytool.exe" -genkeypair -keystore $ks -alias androiddebugkey `
    -storepass android -keypass android -keyalg RSA -keysize 2048 -validity 10000 `
    -dname 'CN=Horun Mobile Debug,O=Horun,C=CN'
  if ($LASTEXITCODE -ne 0) { throw 'keytool 失败' }
  Copy-Item $ks (Join-Path $src 'debug.keystore') -Force
}
& "$BT\apksigner.bat" sign --ks $ks --ks-key-alias androiddebugkey `
  --ks-pass pass:android --key-pass pass:android `
  --v1-signing-enabled true --v2-signing-enabled true `
  --out $apk $aligned
if ($LASTEXITCODE -ne 0) { throw 'apksigner 失败' }

& "$BT\apksigner.bat" verify --verbose $apk | Select-Object -First 4

$finalName = "HorunDrama-mobile-$versionName-standalone.apk"
Copy-Item $apk (Join-Path $out $finalName) -Force
$finalPath = Join-Path $out $finalName
$size = (Get-Item $finalPath).Length
$hash = (Get-FileHash $finalPath -Algorithm SHA256).Hash
Write-Host ''
Write-Host "APK: $finalPath"
Write-Host "大小: $([math]::Round($size / 1MB, 2)) MB"
Write-Host "SHA-256: $hash"



