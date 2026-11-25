/**
 * 应用内导航的小工具。
 *
 * 2.0.0 之前播放页的「返回」和 Esc 都写死跳 `#/feed`，用户从剧场/榜单/搜索
 * 进播放页，一按返回就被扔到推荐页。这里统一记录"从哪个页面进的播放页"，
 * 优先走浏览器历史（这样右键/鼠标侧键/Alt+← 也能用），没有历史才回记录页。
 */

import type { View } from './store.ts';
import { hashOf } from './routes.ts';

const PLAY_ORIGIN_KEY = 'horun-play-origin';

/**
 * 记住进入播放页之前的页面。
 *
 * 只在"浏览页 → 播放页"那一下调用（连播切集不会调），所以这里必须**覆盖**旧值：
 * sessionStorage 跨刷新还在，如果只在没有记录时写，上一次会话的 `#/` 会一直生效，
 * 用户从推荐页进播放页再返回就会错误地回到剧场。
 */
export function rememberPlayOrigin(view: View): void {
  try {
    sessionStorage.setItem(PLAY_ORIGIN_KEY, hashOf(view));
  } catch {
    /* 隐私模式/存储被禁用时忽略：返回时退回兜底页 */
  }
}

/** 读取进入播放页之前的页面；没有记录时返回 null。 */
export function readPlayOrigin(): string | null {
  try {
    return sessionStorage.getItem(PLAY_ORIGIN_KEY);
  } catch {
    return null;
  }
}

/** 离开播放页时清掉来源记录。 */
export function clearPlayOrigin(): void {
  try {
    sessionStorage.removeItem(PLAY_ORIGIN_KEY);
  } catch {
    /* 忽略 */
  }
}

/**
 * 返回上一页。
 *
 * 规则：
 * 1. 正在网页全屏 → 先退出全屏（和主流播放器一致，Esc 的第一下不跳页）；
 * 2. 有历史记录 → `history.back()`，保留浏览器前进/后退语义；
 * 3. 直接打开播放页（没有来源）→ 回剧场首页，而不是推荐页。
 */
export function goBack(fallback = '#/'): void {
  if (document.fullscreenElement !== null) {
    void document.exitFullscreen().catch(() => undefined);
    return;
  }
  const origin = readPlayOrigin();
  if (origin !== null) {
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
    location.hash = origin;
    return;
  }
  // 直接打开播放页（没有来源）：回剧场首页，绝不 history.back 到空白页
  location.hash = fallback;
}

/**
 * 播放页内部换集：用 replaceState 而不是 `location.hash =`。
 *
 * 自动下一集/选集如果每次 hash 都 push，历史栈会变成
 * `feed → play(1) → play(2) → play(3)`，用户点返回只会一集一集往回退。
 * 换集不改变"从哪里进的播放页"，所以替换当前条目即可。
 */
export function replacePlayHash(hash: string): void {
  if (location.hash === hash) return;
  try {
    history.replaceState({ horun: true, play: true }, '', hash);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } catch {
    location.hash = hash;
  }
}
