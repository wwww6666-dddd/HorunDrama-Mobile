# 自动把 APK 装到 USB 安卓设备：自动等设备、亮屏、处理华为“风险提示/继续安装”、
# 需要锁屏密码时自动输入，装完自动启动。
# 用法：.\安装到手机.ps1 [-Serial <序列号>] [-Apk <apk路径>] [-Package <包名>] [-LockPin <锁屏密码>] [-NoLaunch]
param(
    [string]$Serial = '',
    [string]$Apk = '',
    [string]$Package = 'com.horun.drama',
    [string]$LockPin = '',
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$adb = Join-Path $root 'android-sdk\platform-tools\adb.exe'
if (-not $Apk) { $Apk = Join-Path $root 'android\out\HorunDrama-mobile-1.1.6-standalone.apk' }
$tmp = Join-Path $root '.tmp'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

if (-not (Test-Path $adb)) { throw "找不到 adb：$adb" }
if (-not (Test-Path $Apk)) { throw "找不到 APK：$Apk" }

function Get-DeviceLines {
    & $adb devices -l 2>$null | Where-Object { $_ -match '^\S+\s+(device|unauthorized|offline)' }
}

function Get-Focus {
    $out = (& $adb -s $script:s shell dumpsys window 2>$null | Out-String)
    $m = [regex]::Match($out, 'mCurrentFocus=Window\{[^}]*\s([^\s/]+)/')
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
}

function Get-ScreenSize {
    $raw = (& $adb -s $script:s shell wm size 2>$null | Out-String)
    $m = [regex]::Match($raw, '(\d+)x(\d+)')
    if (-not $m.Success) { throw '读不到屏幕尺寸' }
    return @([int]$m.Groups[1].Value, [int]$m.Groups[2].Value)
}

function Tap-Ratio([double]$x, [double]$y) {
    $size = Get-ScreenSize
    $px = [int]($size[0] * $x)
    $py = [int]($size[1] * $y)
    & $adb -s $script:s shell input tap $px $py 2>$null | Out-Null
}

function Get-UiXml {
    $remote = '/sdcard/horun-ui.xml'
    $local = Join-Path $tmp 'horun-ui.xml'
    Remove-Item $local -Force -ErrorAction SilentlyContinue
    & $adb -s $script:s shell "uiautomator dump $remote" 2>$null | Out-Null
    & $adb -s $script:s pull $remote $local 2>$null | Out-Null
    if (-not (Test-Path $local)) { return $null }
    try { return [xml](Get-Content $local -Raw) } catch { return $null }
}

function Find-TextNode([xml]$doc, [string]$text) {
    if (-not $doc) { return $null }
    foreach ($n in $doc.SelectNodes('//node')) {
        if ($n.text -eq $text) { return $n }
    }
    return $null
}

function Tap-Bounds([string]$bounds) {
    $m = [regex]::Match($bounds, '\[(\d+),(\d+)\]\[(\d+),(\d+)\]')
    if (-not $m.Success) { return $false }
    $x = ([int]$m.Groups[1].Value + [int]$m.Groups[3].Value) / 2
    $y = ([int]$m.Groups[2].Value + [int]$m.Groups[4].Value) / 2
    & $adb -s $script:s shell input tap ([int]$x) ([int]$y) 2>$null | Out-Null
    return $true
}

function Test-CheckboxChecked {
    $size = Get-ScreenSize
    $png = Join-Path $tmp 'horun-checkbox.png'
    & $adb -s $script:s exec-out screencap -p > $png 2>$null
    try {
        Add-Type -AssemblyName System.Drawing
        $bmp = [System.Drawing.Bitmap]::FromFile($png)
        $c = $bmp.GetPixel([int]($size[0] * 0.17), [int]($size[1] * 0.87))
        $bmp.Dispose()
        return ($c.B -gt 150 -and $c.R -lt 120)
    } catch { return $false }
}

function Invoke-LockUnlock {
    if (-not $LockPin) { return $false }
    & $adb -s $script:s shell input keyevent KEYCODE_WAKEUP 2>$null | Out-Null
    & $adb -s $script:s shell input swipe ([int]((Get-ScreenSize)[0] / 2)) ([int]((Get-ScreenSize)[1] * 0.8)) ([int]((Get-ScreenSize)[0] / 2)) ([int]((Get-ScreenSize)[1] * 0.2)) 300 2>$null | Out-Null
    Start-Sleep -Milliseconds 800
    & $adb -s $script:s shell input text $LockPin 2>$null | Out-Null
    & $adb -s $script:s shell input keyevent 66 2>$null | Out-Null
    Start-Sleep -Seconds 2
    return $true
}

# 等设备：最多 90 秒；空列表时自动重启 adb server（USB 刚插上常见）
& $adb start-server 2>$null | Out-Null
$deadline = (Get-Date).AddSeconds(90)
$restarted = $false
while ((Get-Date) -lt $deadline) {
    $lines = @(Get-DeviceLines)
    if ($lines.Count -gt 0) { break }
    if (-not $restarted) {
        & $adb kill-server 2>$null | Out-Null
        Start-Sleep -Seconds 2
        & $adb start-server 2>$null | Out-Null
        $restarted = $true
    }
    Start-Sleep -Seconds 3
}

$lines = @(Get-DeviceLines)
if ($lines.Count -eq 0) { throw '没有检测到设备：插 USB，打开「开发者选项 → USB 调试」，弹窗点『允许』后重跑' }

$devices = @($lines | ForEach-Object {
    $parts = $_ -split '\s+'
    [pscustomobject]@{ Serial = $parts[0]; State = $parts[1]; Raw = $_ }
})
$ready = @($devices | Where-Object State -eq 'device')
if ($ready.Count -eq 0) {
    $bad = $devices | ForEach-Object { "$($_.Serial) ($($_.State))" }
    throw "设备未授权或离线：$($bad -join '、')；请在手机上点『允许 USB 调试』后重跑"
}

if ($Serial) {
    $target = $ready | Where-Object Serial -eq $Serial | Select-Object -First 1
    if (-not $target) { throw "指定设备不在线或未授权：$Serial" }
} elseif ($ready.Count -eq 1) {
    $target = $ready[0]
} else {
    throw "检测到多台设备，请加 -Serial 指定：$($ready.Serial -join '、')"
}

$script:s = $target.Serial
$model = (& $adb -s $script:s shell getprop ro.product.model 2>$null).Trim()
$abi = (& $adb -s $script:s shell getprop ro.product.cpu.abi 2>$null).Trim()
$sdk = (& $adb -s $script:s shell getprop ro.build.version.sdk 2>$null).Trim()
Write-Host "设备：$model  Android API $sdk  $abi  $($script:s)"

& $adb -s $script:s shell input keyevent KEYCODE_WAKEUP 2>$null | Out-Null
& $adb -s $script:s shell wm dismiss-keyguard 2>$null | Out-Null
Start-Sleep -Milliseconds 500

Write-Host "安装：$Apk"
$outFile = Join-Path $tmp 'install-adb.out.txt'
$errFile = Join-Path $tmp 'install-adb.err.txt'
$p = Start-Process -FilePath $adb -ArgumentList @('-s', $script:s, 'install', '-r', $Apk) -PassThru -NoNewWindow -RedirectStandardOutput $outFile -RedirectStandardError $errFile

$installDone = $false
$deadline = (Get-Date).AddSeconds(180)
$lastAction = ''
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $focus = Get-Focus

    if ($focus -match 'coauthservice|unifiedauth') {
        if ($LockPin) {
            $doc = Get-UiXml
            $pinNode = $null
            if ($doc) {
                $pinNode = $doc.SelectNodes('//node[@resource-id="com.huawei.coauthservice:id/pin_password_entry"]') | Select-Object -First 1
            }
            if ($pinNode) { Tap-Bounds $pinNode.bounds | Out-Null }
            & $adb -s $script:s shell input text $LockPin 2>$null | Out-Null
            Start-Sleep -Milliseconds 500
            & $adb -s $script:s shell input keyevent 66 2>$null | Out-Null
            Write-Host '已输入锁屏密码'
            Start-Sleep -Seconds 8
        } else {
            throw '安装需要锁屏密码：请加 -LockPin 传入密码后重跑'
        }
        continue
    }

    if ($focus -match 'appmarket|appgallery|InstallDistActivity|packageinstaller') {
        $doc = Get-UiXml
        $success = Find-TextNode $doc '安装成功'
        $done = Find-TextNode $doc '完成'
        if ($success -and $done) {
            if (Tap-Bounds $done.bounds) {
                Write-Host '已点『完成』'
                $installDone = $true
                Start-Sleep -Seconds 2
                break
            }
        }

        $risk = Find-TextNode $doc '风险提示'
        $cont = Find-TextNode $doc '继续安装'
        if ($risk -and $cont) {
            if (Tap-Bounds $cont.bounds) {
                Write-Host '已点『继续安装』（风险提示）'
                $lastAction = 'risk'
                Start-Sleep -Seconds 4
                continue
            }
        }

        # 详情页：先勾“已了解…”，再点底部“继续安装”
        if (-not (Test-CheckboxChecked)) {
            Tap-Ratio 0.17 0.87
            Start-Sleep -Milliseconds 800
            if (-not (Test-CheckboxChecked)) { Tap-Ratio 0.17 0.87 }
            Write-Host '已勾选风险确认'
            Start-Sleep -Milliseconds 500
        }
        if (Test-CheckboxChecked) {
            Tap-Ratio 0.50 0.95
            Write-Host '已点『继续安装』（详情页）'
            $lastAction = 'detail'
            Start-Sleep -Seconds 6
            continue
        }
    }

    $p.Refresh()
    if ($p.HasExited) {
        $out = if (Test-Path $outFile) { (Get-Content $outFile -Raw).Trim() } else { '' }
        if ($out -match 'Success') { $installDone = $true; break }
        if ($lastAction -eq '' -and $out -notmatch 'Success') {
            throw "安装失败：$out"
        }
    }
}

$p.Refresh()
if (-not $p.HasExited) {
    try { $p.WaitForExit(5000) | Out-Null } catch {}
}
$out = ''
$err = ''
if (Test-Path $outFile) {
    $raw = Get-Content $outFile -Raw
    if ($null -ne $raw) { $out = [string]$raw }
}
if (Test-Path $errFile) {
    $raw = Get-Content $errFile -Raw
    if ($null -ne $raw) { $err = [string]$raw }
}
$out = $out.Trim()
$err = $err.Trim()
Write-Host $out
if ($err) { Write-Host $err }

if ($out -notmatch 'Success') {
    throw '安装未完成：请检查手机上的风险提示是否还需要点，或看上面的 adb 输出'
}

if (-not $NoLaunch -and $Package) {
    Write-Host "启动：$Package"
    & $adb -s $script:s shell monkey -p $Package -c android.intent.category.LAUNCHER 1 2>$null | Out-Null
}

Write-Host '完成。'
