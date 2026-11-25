/** 手机端自己的路由与导航上下文：跟桌面端的 view 体系无关。 */

import { createContext, useContext } from 'react';

export type MRoute =
  | 'home'
  | 'feed'
  | 'rank'
  | 'library'
  | 'me'
  | 'settings'
  | 'search'
  | 'about'
  | 'new'
  | 'category'
  | 'downloads';

/**
 * 底栏 4 个 Tab，顺序按官方：首页（推荐流）、剧场（书城）、追剧、我的。
 * 榜单不再是底栏——入口移到剧场胶囊和搜索页的榜单区（阶段 A 定的口径）。
 */
export const TABS: Array<{ route: MRoute; label: string }> = [
  { route: 'feed', label: '首页' },
  { route: 'home', label: '剧场' },
  { route: 'library', label: '追剧' },
  { route: 'me', label: '我的' },
];

/** hash 兼容：老的 #/theater、#/settings 也能落到对应页面 */
const ALIAS: Record<string, MRoute> = {
  '': 'home',
  home: 'home',
  theater: 'home',
  feed: 'feed',
  rank: 'rank',
  library: 'library',
  me: 'me',
  settings: 'settings',
  search: 'search',
  about: 'about',
  new: 'new',
  newreleases: 'new',
  category: 'category',
  downloads: 'downloads',
  persons: 'rank',
};

export function parseRoute(hash: string): MRoute {
  const raw = hash.replace(/^#\/?/, '').split('/')[0] ?? '';
  return ALIAS[raw] ?? 'home';
}

export function hashOfRoute(route: MRoute): string {
  return route === 'home' ? '#/' : `#/${route}`;
}

export interface NavApi {
  route: MRoute;
  go: (next: MRoute) => void;
  back: () => void;
  openDetail: (seriesId: string) => void;
  play: (seriesId: string, episodeId: string, no: number) => void;
  /** 顶栏滚动进度：0 = 顶部，1 = 完全收起 */
  scrolled: boolean;
}

export const NavContext = createContext<NavApi | null>(null);

/** 桌面端视图被手机壳复用时，可能没有导航上下文；用这个安全版本。 */
export function useMaybeNav(): NavApi | null {
  return useContext(NavContext);
}

export function useNav(): NavApi {
  const nav = useContext(NavContext);
  if (nav === null) throw new Error('导航上下文缺失');
  return nav;
}
