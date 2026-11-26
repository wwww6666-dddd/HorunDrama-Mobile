/** Electron 预加载脚本暴露的能力（网页里用 window.yimu 判断是否在桌面壳里）。 */

export interface YimuBridge {
  openLogin?: () => Promise<unknown>;
  /** 同步深浅主题给主进程（DWM 边框颜色） */
  setTheme?: (theme: 'dark' | 'light') => Promise<boolean>;
  toggleFullscreen?: () => Promise<boolean>;
  isFullscreen?: () => Promise<boolean>;
  setFullscreen?: (v: boolean) => Promise<boolean>;
  pickDirectory?: (current?: string) => Promise<{ ok: boolean; path?: string }>;
  toggleMini?: () => Promise<boolean>;
  openMini?: (payload: unknown) => Promise<unknown>;
  closeMini?: () => Promise<boolean>;
  resizeMini?: (size: { w: number; h: number }) => Promise<boolean>;
  minimize?: () => Promise<void>;
  /** 用系统浏览器打开外链（反馈/GitHub/更新下载） */
  openExternal?: (url: string) => Promise<boolean>;
  /** 自动更新：后台下载更新包（主进程写文件，带进度） */
  updateDownload?: (payload: {
    url: string;
    name: string;
    size?: number;
    digest?: string;
  }) => Promise<{ ok: boolean; path?: string; size?: number; sha256?: string; mode?: 'parallel' | 'single'; connections?: number; message?: string }>;
  /** 自动更新：退出并解压覆盖，然后重启 */
  updateInstall?: (payload: { path: string }) => Promise<{ ok: boolean; message?: string }>;
  /** 下载进度：0~1 */
  onUpdateProgress?: (cb: (payload: {
    received: number;
    total: number;
    percent: number;
    /** 主进程实际使用的下载方式：多连接 Range 分片 / 单连接兜底 */
    mode?: 'parallel' | 'single';
    connections?: number;
  }) => void) => () => void;
  /** 写剪贴板（主进程 clipboard） */
  copyText?: (text: string) => Promise<boolean>;
  toggleMaximize?: () => Promise<void>;
  close?: () => Promise<void>;
  isMaximized?: () => Promise<boolean>;
  onWindowState?: (cb: (state: { maximized: boolean; fullscreen: boolean }) => void) => () => void;
  /** 小窗打开时在主窗口触发（用于暂停主窗口播放，避免两路声音） */
  onMiniOpened?: (cb: (payload: { seriesId: string; episodeId: string; no: number }) => void) => () => void;
  /** 小窗「还原」：关掉小窗并把主窗口拉到前台 */
  focusMain?: () => Promise<boolean>;
  /** 小窗关闭后触发（主窗口据此恢复播放） */
  onMiniClosed?: (cb: () => void) => () => void;
  /** 手动拖动窗口：按下开始，松手结束（无边框窗口） */
  dragStart?: () => Promise<boolean>;
  dragEnd?: () => Promise<boolean>;
  onLoginChanged?: (cb: (payload: unknown) => void) => () => void;
  platform?: string;
}

/** Android 壳（MainActivity）暴露的能力：网页里用 window.HorunAndroid 判断是否在手机 App 里。 */
export interface HorunAndroidBridge {
  getServerUrl: () => string;
  setServerUrl: (url: string) => void;
  openSetup: () => void;
  toast: (message: string) => void;
  /** 系统栏配色：剧场/我的 light，推荐/播放 dark */
  setBars?: (mode: 'light' | 'dark') => void;
  /** 视频页允许横屏（auto）/ 其他页面锁竖屏（portrait） */
  setOrientation?: (mode: 'auto' | 'portrait') => void;
  /** 横屏播放时进入沉浸式全屏（隐藏系统栏） */
  setImmersive?: (on: boolean) => void;
  /** 系统字号缩放：90~125（WebView textZoom） */
  setFontScale?: (percent: number) => void;
  /** 下载更新 APK：url + 文件名 + sha256(可空) + 线程数；内部四线程 Range 分段 */
  downloadUpdate?: (url: string, fileName: string, sha256: string, threads: number) => void;
  /** 更新状态：idle | downloading | downloaded | failed */
  getUpdateState?: () => string;
  /** 安装已经下载好的 APK */
  installUpdate?: () => void;
}

declare global {
  interface Window {
    yimu?: YimuBridge;
    HorunAndroid?: HorunAndroidBridge;
  }
}

export {};
