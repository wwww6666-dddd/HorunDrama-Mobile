import { create } from 'zustand';
import { api, type AccountStatus } from './api.ts';
import type { UpdateInfo } from './app-info.ts';
import { parseHash } from './routes.ts';

/** 视图：与旧版的 9 个 hash 路由对齐，详情/播放后续作为独立层叠加。 */
export type View =
  | 'theater'
  | 'feed'
  | 'newreleases'
  | 'rank'
  | 'category'
  | 'library'
  | 'downloads'
  | 'search'
  | 'settings';

export type Theme = 'dark' | 'light';
export type Accent = 'ember' | 'jade' | 'violet' | 'azure';
export type LibraryTab = 'fav' | 'history' | 'likes' | 'follow';

interface AppState {
  view: View;
  theme: Theme;
  accent: Accent;
  /** 新核心连上了没有：null=未知 */
  coreOk: boolean | null;
  /** 账号状态：null=还没查 */
  account: AccountStatus | null;
  /** 检测到的新版本；null=没有更新 */
  updateInfo: UpdateInfo | null;
  /** 更新卡片是否展开（只有点顶栏更新按钮/手动检查才打开） */
  updateCardOpen: boolean;
  setUpdateInfo: (info: UpdateInfo | null) => void;
  openUpdateCard: () => void;
  closeUpdateCard: () => void;
  /** 登录弹窗开关 */
  loginOpen: boolean;
  /** 打赏弹窗开关 */
  rewardOpen: boolean;
  openReward: () => void;
  closeReward: () => void;
  /** 「分享续播」弹窗开关（复制本集链接 / 解析别人分享的红果链接） */
  shareOpen: boolean;
  /** 搜索页「识剧」复用分享弹层时用浅色，跟搜索页保持一致 */
  shareLight: boolean;
  openShare: (light?: boolean) => void;
  closeShare: () => void;
  refreshAccount: () => Promise<void>;
  openLogin: () => void;
  closeLogin: () => void;
  /** 当前打开的详情（剧 id）；null=关闭 */
  detailId: string | null;
  setView: (view: View) => void;
  /** 打开追剧页时默认选中的 tab（侧栏「追更/预约」用） */
  libraryTab: LibraryTab;
  setLibraryTab: (tab: LibraryTab) => void;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setAccent: (accent: Accent) => void;
  setCoreOk: (ok: boolean) => void;
  setAccount: (account: AccountStatus | null) => void;
  openDetail: (seriesId: string) => void;
  closeDetail: () => void;
}

function readTheme(): Theme {
  const saved = localStorage.getItem('horun-theme');
  if (saved === 'dark' || saved === 'light') return saved;
  // 手机端默认深色：和红果/短剧的沉浸看片场景一致，首屏不会闪白
  return 'dark';
}

function readAccent(): Accent {
  const saved = localStorage.getItem('horun-accent');
  if (saved === 'ember' || saved === 'jade' || saved === 'violet' || saved === 'azure') return saved;
  return 'ember';
}

const initialTheme = readTheme();
const initialAccent = readAccent();
document.documentElement.dataset.theme = initialTheme;
document.documentElement.dataset.accent = initialAccent;

/** 桌面壳里才有的东西：右上角窗口按钮的样式与拖动区（见 styles.css）。 */
function syncShell(): void {
  document.documentElement.dataset.shell = window.yimu === undefined ? 'web' : 'electron';
}

export const useApp = create<AppState>((set, get) => ({
  // 首屏直接按 hash 落位：否则 #/feed、#/settings 这类深链会先渲染剧场，
  // App 的 hash 校正 effect 又把地址改回 #/，用户看到的就是"深链失效/后退到推荐页"。
  view: parseHash(location.hash),
  theme: initialTheme,
  accent: initialAccent,
  coreOk: null,
  account: null,
  updateInfo: null,
  updateCardOpen: false,
  setUpdateInfo: (updateInfo) => set({ updateInfo, updateCardOpen: updateInfo !== null ? get().updateCardOpen : false }),
  openUpdateCard: () => set({ updateCardOpen: true }),
  closeUpdateCard: () => set({ updateCardOpen: false }),
  loginOpen: false,
  detailId: null,
  libraryTab: 'fav',
  setView: (view) => set({ view }),
  setLibraryTab: (libraryTab) => set({ libraryTab }),
  setTheme: (theme) => {
    localStorage.setItem('horun-theme', theme);
    document.documentElement.dataset.theme = theme;
    syncShell();
    // Win11 无边框窗口的 DWM 边框颜色跟 nativeTheme 走：不同步会留一条白边
    void window.yimu?.setTheme?.(theme).catch(() => undefined);
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
  setAccent: (accent) => {
    localStorage.setItem('horun-accent', accent);
    document.documentElement.dataset.accent = accent;
    set({ accent });
  },
  setCoreOk: (coreOk) => set({ coreOk }),
  setAccount: (account) => set({ account }),
  refreshAccount: async () => {
    try {
      const account = await api.accountStatus();
      set({ account });
    } catch {
      set({ account: null });
    }
  },
  openLogin: () => set({ loginOpen: true }),
  rewardOpen: false,
  openReward: () => set({ rewardOpen: true }),
  closeReward: () => set({ rewardOpen: false }),
  shareOpen: false,
  shareLight: false,
  openShare: (light = false) => set({ shareOpen: true, shareLight: light }),
  closeShare: () => set({ shareOpen: false }),
  closeLogin: () => set({ loginOpen: false }),
  openDetail: (seriesId) => set({ detailId: seriesId }),
  closeDetail: () => set({ detailId: null }),
}));
