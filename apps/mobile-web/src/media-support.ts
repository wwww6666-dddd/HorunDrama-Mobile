/**
 * 运行时媒体能力探测。
 *
 * 用途：Electron 的 Chromium 在 Windows 上通常能硬解 HEVC（取决于系统是否装了
 * HEVC 视频扩展），能解的话服务端就不必把 HEVC 重编码成 H.264 —— 1080p 的准备
 * 时间从 ~10 秒降到 ~1.5 秒（只解密 + 重封装），画质也零损失。
 *
 * 判断不出来就返回 false，服务端会退回安全的 H.264 转码路径。
 */
function probe(types: string[]): boolean {
  try {
    const video = document.createElement('video');
    return types.some((type) => video.canPlayType(type) !== '');
  } catch {
    return false;
  }
}

/** 能播 HEVC（hvc1/hev1 任一） */
export const CAN_PLAY_HEVC = probe([
  'video/mp4; codecs="hvc1.1.6.L120.90"',
  'video/mp4; codecs="hev1.1.6.L120.90"',
  'video/mp4; codecs="hvc1"',
  'video/mp4; codecs="hev1"',
]);
