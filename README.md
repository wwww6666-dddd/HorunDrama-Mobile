# HorunDrama Mobile

红果短剧第三方移动端（Android WebView + 内置 Node 核心），以官方 7.4.5.32 的版式与信息架构为参照，只保留「找剧 / 看剧 / 追剧」。

> 仅用于个人学习与技术研究，不提供任何官方内容源，不含广告、支付、福利或 AI 功能。

## 1.3.5 能做什么

- 首页推荐流：手机端视频按真实比例完整显示，不放大、不裁切；平板 16:9 居中；右侧收藏、评论、点赞、分享同一条中轴；左下 @剧名 + 简介。
- 剧场：11 个频道，手机 2 列 / 平板 3 列瀑布流，触底自动续页；右列继续观看。
- 播放：16:9 画面、上滑下一集 / 下滑上一集、自动连播（`ended` + 进度兜底）、选集、清晰度、倍速、清屏、弹幕。
- 我的：历史 / 收藏 / 点赞 / 预约；右上角深浅模式一键切换，带圆形揭示过渡（WebView 109 降级淡入）；右上搜索只搜本机记录。
- 设置：跟随系统 / 深色 / 浅色，6 种主题色，字体大小，自动连播，默认倍速/清晰度，预加载，跳过片头片尾，缓存统计与上限（1~32GB，超限自动清理），自动更新；开关使用实色轨道并在轨道内显示“开/关”，主题色会同步改变页面背景、我的头图和设置卡。
- 横屏：推荐流与播放页跟随传感器横屏，自动隐藏状态栏/导航栏，顶部频道与底栏收起，画面 0.46s 缩放淡入；离开视频页恢复竖屏。
- 音画：单个 `<video>` 承载同一 MP4 的音视频轨；换源后等 `canplay`、seek 到起播点，并确认音频/视频解码字节都就绪再统一 `play()`，避免音频先出声、画面还在解码。
- 离线快照：首页、继续观看、推荐流、详情、播放详情先读本机快照，进页面不再白屏等接口。
- **真实 1080p**：随 APK 打包 Rust `hg-resolve` 侧车（MetaSec v5/SDI），取 1080p 直链 + CENC key；侧车失败回退旧 App 源，再退官网 360p。1.3.2 修复精简 ffmpeg 无 `pipe` 协议导致转码必失败的问题；1.3.3 复验 App 内 1920×1080 HEVC 可播；1.3.4 修复冷启动无缓存时纯 `copy` 仍先探测 H.264 编码器的问题；1.3.5 完成双轨起播门控与 Feed 真实时长进度条。
- 页面切换、播放器进入、推荐流换集、简介展开均有入场过渡；简介面板从底部向上展开，长文在面板内滚动。

## 自动更新

- Release 仓库：<https://github.com/wwww6666-dddd/HorunDrama-Mobile/releases>
- APK 每天检查一次 GitHub Release；发现新版本后 **4 线程 Range 分段下载** → 合并 → SHA-256 校验 → 系统安装器。
- Android 8+ 首次需允许「安装未知应用」；授权返回后会自动继续安装。
- 设置 → 关于 → 自动更新可关闭；也可手动「检查更新 / 下载更新」。

## 构建

环境：Windows + Node 20+ + pnpm + Android SDK（`android-sdk` 已随工程本地化）。

```powershell
pnpm install
pnpm --filter @horun/mobile-web run build
# 把 hgresolve.zip 解到 .tmp\hgresolve（含两个 ABI 的 libhgresolve.so 与 metasec）
cd android
.\prepare-runtime.ps1
.\prepare-runtime-x86.ps1
.\build.ps1
```

产物：`android/out/HorunDrama-mobile-<version>-standalone.apk`（arm64-v8a + x86_64）。

安装到已连接设备：

```powershell
.\安装到手机.ps1 -Serial <serial>
```

## 目录

```
apps/mobile-web      前端（React + Vite，手机/桌面两套壳）
apps/mobile-core     内置 Node 核心（目录、播放、账号、缓存）
android              壳工程与打包脚本
docs                 开发文档、进度文档、官方对照
scripts              截图 / 数据 / 运行辅助脚本
```

## 已知限制

- 2026-11-23 上游改了播放请求校验；旧纯 JS 签名会收到 HTTP 200 + 0 字节。1.3.2 已用 `hg-resolve` 侧车解决，核心与 App 内均实测真实 1920×1080 HEVC。设备不支持 HEVC 硬解时，内置精简 ffmpeg 不含 H.264 编码器，会自动回落官网 360p，不会伪造高清。
- 剧场「社区 / 电影 / 听书 / 小说 / 漫画 / 长征 / 经典 / 知识」暂无上游数据，显示「暂未接入」。
- 本项目不包含官方素材版权；字体、封面、视频均来自上游接口，仅供学习。
