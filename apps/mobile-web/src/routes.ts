import type { View } from './store.ts';

export interface RouteSpec {
  view: View;
  label: string;
  /** 旧版 hash（迁移期做兼容跳转用） */
  legacyHash: string;
}

export const ROUTES: RouteSpec[] = [
  { view: 'theater', label: '剧场', legacyHash: '#/' },
  { view: 'feed', label: '推荐', legacyHash: '#/feed' },
  { view: 'newreleases', label: '新剧', legacyHash: '#/new' },
  { view: 'rank', label: '榜单', legacyHash: '#/rank' },
  { view: 'category', label: '分类', legacyHash: '#/category' },
  { view: 'library', label: '追剧', legacyHash: '#/library' },
  { view: 'downloads', label: '下载', legacyHash: '#/downloads' },
  { view: 'search', label: '搜索', legacyHash: '#/search' },
  { view: 'settings', label: '设置', legacyHash: '#/settings' },
];

const BY_VIEW = new Map(ROUTES.map((r) => [r.view, r]));

export function isView(value: string): value is View {
  return BY_VIEW.has(value as View);
}

/** 解析 `#/rank` 与旧版 `#/rank/xxx` 形态；认不出就回剧场。 */
export function parseHash(hash: string): View {
  const raw = hash.replace(/^#\/?/, '').split('/')[0] ?? '';
  if (isView(raw)) return raw;
  if (raw === 'home') return 'theater';
  if (raw === 'person' || raw === 'series') return 'theater';
  return 'theater';
}

export function hashOf(view: View): string {
  return view === 'theater' ? '#/' : `#/${view}`;
}

export interface PlayRoute {
  seriesId: string;
  episodeId: string;
  no: number;
  /** 「分享续播」带过来的起播位置（秒）；0 = 按本地进度续播 */
  startAt: number;
}

/**
 * 播放页的 hash：`#/play/<seriesId>/<episodeId>/<no>[?t=123.4]`。
 * 单独解析而不是塞进 View：播放页是全屏的，不显示顶栏和胶囊导航。
 *
 * `t` 只给「分享续播」用：别人粘贴你分享的红果链接时，从这一秒接着看。
 */
export function parsePlay(hash: string): PlayRoute | null {
  const m = /^#\/play\/(\d{6,25})\/(\d{6,25})\/(\d{1,4})/.exec(hash);
  if (m === null) return null;
  const q = /[?&]t=([\d.]+)/.exec(hash);
  const t = q?.[1] === undefined ? 0 : Number.parseFloat(q[1]);
  return {
    seriesId: m[1] ?? '',
    episodeId: m[2] ?? '',
    no: Number.parseInt(m[3] ?? '1', 10),
    startAt: Number.isFinite(t) ? Math.max(0, t) : 0,
  };
}

export function playHash(seriesId: string, episodeId: string, no: number, startAt = 0): string {
  const t = startAt > 0 ? `?t=${startAt.toFixed(1)}` : '';
  return `#/play/${seriesId}/${episodeId}/${no}${t}`;
}

export interface MiniRoute {
  seriesId: string;
  episodeId: string;
  no: number;
  /** 小窗打开瞬间的播放位置（秒），用来无缝接续 */
  startAt: number;
}

/**
 * 小窗路由：`#/mini/<seriesId>/<episodeId>/<no>?t=12.5`
 * 单独一个路由，是因为小窗要渲染"只有画面 + 微控制"的迷你播放器，
 * 不能复用完整播放页（顶栏/控制条/弹幕层在 340px 宽度里全是噪音）。
 */
export function parseMini(hash: string): MiniRoute | null {
  const m = /^#\/mini\/(\d{6,25})\/(\d{6,25})\/(\d{1,4})/.exec(hash);
  if (m === null) return null;
  const q = /[?&]t=([\d.]+)/.exec(hash);
  const t = q?.[1] === undefined ? 0 : Number.parseFloat(q[1]);
  return {
    seriesId: m[1] ?? '',
    episodeId: m[2] ?? '',
    no: Number.parseInt(m[3] ?? '1', 10),
    startAt: Number.isFinite(t) ? Math.max(0, t) : 0,
  };
}

export function miniHash(seriesId: string, episodeId: string, no: number, startAt: number): string {
  const t = startAt > 0 ? `?t=${startAt.toFixed(1)}` : '';
  return `#/mini/${seriesId}/${episodeId}/${no}${t}`;
}
