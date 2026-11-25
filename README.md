# HorunDrama Mobile

红果短剧第三方移动端（Android WebView + 内置 Node 核心），以官方 7.4.5.32 的版式与信息架构为参照，只保留「找剧 / 看剧 / 追剧」。

> 仅用于个人学习与技术研究，不提供任何官方内容源，不含广告、支付、福利或 AI 功能。

## 1.3.0 能做什么

- 首页推荐流：手机满屏沉浸、平板 16:9 居中；顶栏频道 / 搜索 / 快捷入口；右侧收藏、评论、点赞、分享。
- 剧场：11 个频道，手机 2 列 / 平板 3 列瀑布流，触底自动续页；右列继续观看。
- 播放：16:9 画面、上滑下一集 / 下滑上一集、自动连播（`ended` + 进度兜底）、选集、清晰度、倍速、清屏、弹幕。
- 我的：历史 / 收藏 / 点赞 / 预约；右上搜索只搜本机记录。
- 设置：跟随系统 / 深色 / 浅色，6 种主题色，字体大小，自动连播，默认倍速/清晰度，预加载，跳过片头片尾，缓存统计与上限（1~32GB，超限自动清理），自动更新。
- 离线快照：首页、继续观看、推荐流、详情、播放详情先读本机快照，进页面不再白屏等接口。

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

- 2026-11-23/24 起上游对匿名签名的 `/novel/player/video_model/v1/` 返回 HTTP 200 + 0 字节，第三方与官方匿名请求都取不到高清；客户端已做空响应熔断与 360p 秒开兜底，不伪造高清。
- 剧场「社区 / 电影 / 听书 / 小说 / 漫画 / 长征 / 经典 / 知识」暂无上游数据，显示「暂未接入」。
- 本项目不包含官方素材版权；字体、封面、视频均来自上游接口，仅供学习。
