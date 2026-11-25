# 第三方代码说明（apps/core/src/upstream/hongguoweb）

这里的代码不是本项目原创，来自开源项目 **hongguo-web**（作者 sunnysky123，
MIT License，许可证全文见同目录 `LICENSE-hongguo-web`）：

- `core/pure-sign.js`、`core/playback-sign.js`：请求签名（x-gorgon / x-argus /
  x-ladon / x-helios / x-medusa）
- `core/spade.js`：`spade_a` → CENC 内容密钥解包
- `core/safeguards.js`：节流/退避
- `service/app-source.js`：红果 App 播放模型请求（gzip 正文 + video_tab 兜底）
- `service/playback-device.js`：ttEncrypt 匿名设备注册（播放身份一次性）
- `util/*`：HTTP/JSON/日志等小工具

## 额外声明

`service/playback-device.js` 的 ttEncrypt 注册协议，在上游 hongguo-web 项目里
标注为移植自 `tsukiyo-zero/hongguoTV` 的 `DeviceRegister.kt`（GPL-3.0-only）。
如果本项目要做**闭源商业分发**，需要先替换或重写这一段协议实现，避免 GPL 传染；
自己用 / 小范围分享不受影响。

## 我们的改动

- `apps/core/src/sources/appplay.ts`：薄适配层（缓存、串行限速、连续空响应熔断、
  spade 解包、把结果收敛成 `StreamChoice`）。
- `apps/core/src/media/transcode.ts`：拿内容密钥走 ffmpeg
  `-decryption_key`；源是 H.264 时只 `-c copy` 重封装（不重编码）。
