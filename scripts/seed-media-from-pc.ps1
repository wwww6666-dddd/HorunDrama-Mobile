<#
 * 把电脑端已转好的剧集缓存"借"给手机端核心用（硬链接，不占额外空间）。
 *
 * 背景：`D:\红果短剧` 那份工程的 data\cache\media 里已经有一百多集 1080p；
 * 手机端 `D:\红果短剧手机端` 是独立工程、独立缓存目录，冷启动时一集都没有，
 * 于是每次播放都要重新取流/转码，而上游 App 源又在限流（D-47）→ 永远 360p。
 * 两边的缓存文件名规则完全一致（`<集id>-<档位>[-hevc][-增强].mp4`），
 * 同一块 NTFS 盘上做硬链接即可秒级"继承"这些集：不复制数据、不双倍占盘。
 *
 * 安全性：
 *  - 只读源目录，绝不动 PC 工程的文件；
 *  - 目标已存在就跳过，不覆盖；
 *  - 删掉手机端缓存里的某个链接，只是少一个目录项，PC 那份仍在（反之亦然）。
 *
 * 用法：pwsh -File .\scripts\seed-media-from-pc.ps1
 *       pwsh -File .\scripts\seed-media-from-pc.ps1 -WhatIf
#>
param(
  [string]$Source = 'D:\红果短剧\data\cache\media',
  [string]$Target = 'D:\红果短剧手机端\data\cache\media',
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Source)) {
  throw "源缓存目录不存在：$Source"
}
if (-not (Test-Path -LiteralPath $Target)) {
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
}

$files = Get-ChildItem -LiteralPath $Source -File -Filter '*.mp4' |
  Where-Object { $_.Name -match '^\d{8,25}-[0-9a-z]+(?:-(?:standard|strong))?(?:-hevc)?\.mp4$' }

$linked = 0
$copied = 0
$skipped = 0
$failed = 0
$bytes = 0

foreach ($file in $files) {
  $dest = Join-Path $Target $file.Name
  if (Test-Path -LiteralPath $dest) {
    $skipped += 1
    continue
  }
  if ($WhatIf) {
    Write-Output "will link $($file.Name)"
    $linked += 1
    $bytes += $file.Length
    continue
  }
  try {
    New-Item -ItemType HardLink -Path $dest -Target $file.FullName -ErrorAction Stop | Out-Null
    $linked += 1
    $bytes += $file.Length
  } catch {
    # 跨卷/文件系统不支持硬链接时退回复制（会真的占空间，但不让缓存变空）
    try {
      Copy-Item -LiteralPath $file.FullName -Destination $dest -ErrorAction Stop
      $copied += 1
      $bytes += $file.Length
    } catch {
      $failed += 1
      Write-Output "跳过 $($file.Name)：$($_.Exception.Message)"
    }
  }
}

$total = $linked + $copied
"{0} 个候选，硬链接 {1}，复制 {2}，已存在跳过 {3}，失败 {4}；计入 {5:N1} MB" -f `
  $files.Count, $linked, $copied, $skipped, $failed, ($bytes / 1MB)
