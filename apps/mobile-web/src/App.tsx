import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { api } from './api.ts';
import { clearPlayOrigin, rememberPlayOrigin } from './nav.ts';
import { hashOf, parseHash, parseMini, parsePlay, type MiniRoute, type PlayRoute } from './routes.ts';
import { useApp } from './store.ts';
import { DetailDrawer } from './ui/DetailDrawer.tsx';
import { Dock } from './ui/Dock.tsx';
import { TopBar } from './ui/TopBar.tsx';
import { UpdateCard } from './ui/UpdateCard.tsx';
import { MiniPlayer } from './views/MiniPlayer.tsx';
import { LoginDialog } from './ui/LoginDialog.tsx';
import { RewardDialog } from './ui/RewardDialog.tsx';
import { ShareDialog } from './ui/ShareDialog.tsx';
import { Play } from './views/Play.tsx';
import { Theater } from './views/Theater.tsx';
import { Feed } from './views/Feed.tsx';
import { NewReleases } from './views/NewReleases.tsx';
import { Rank } from './views/Rank.tsx';
import { Category } from './views/Category.tsx';
import { Library } from './views/Library.tsx';
import { Downloads } from './views/Downloads.tsx';
import { Search } from './views/Search.tsx';
import { Settings } from './views/Settings.tsx';

const VIEWS = {
  theater: Theater,
  feed: Feed,
  newreleases: NewReleases,
  rank: Rank,
  category: Category,
  library: Library,
  downloads: Downloads,
  search: Search,
  settings: Settings,
} as const;

/**
 * 应用外壳。
 *
 * 路由是 hash 的：`#/feed`、`#/play/...`、`#/mini/...`。
 * 2.0.0 起浏览页的切换会 `pushState` 进历史栈，播放页也会记录来源页，
 * 这样「返回」和浏览器后退都能回到上一页，而不是永远回推荐页。
 */
export function App(): JSX.Element {
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const setTheme = useApp((s) => s.setTheme);
  const theme = useApp((s) => s.theme);
  const [playRoute, setPlayRoute] = useState<PlayRoute | null>(() => parsePlay(location.hash));
  const [miniRoute, setMiniRoute] = useState<MiniRoute | null>(() => parseMini(location.hash));
  /** 最近一个非播放页：进播放页时记下来，返回时用 */
  const lastView = useRef(useApp.getState().view);
  /** 上一次渲染是不是播放页：只在 null → 非 null 的那一下记录来源 */
  const wasPlaying = useRef(playRoute !== null);
  /** 首屏的 hash 校正用 replace，避免多出一条"空白"历史 */
  const booted = useRef(false);

  // 主题：store 初始化后立刻落一次，避免首帧闪白
  useEffect(() => {
    setTheme(theme);
  }, [setTheme, theme]);

  // 双向同步 hash：外链/后退可用，旧版链接也能落回对应页面
  useEffect(() => {
    const sync = (): void => {
      const nextPlay = parsePlay(location.hash);
      const nextMini = parseMini(location.hash);
      setPlayRoute(nextPlay);
      setMiniRoute(nextMini);
      // 播放页/小窗不改变"当前浏览页"，否则返回来源会被覆盖成播放页自身
      if (nextPlay === null && nextMini === null) {
        const nextView = parseHash(location.hash);
        lastView.current = nextView;
        setView(nextView);
      }
    };
    sync();
    window.addEventListener('hashchange', sync);
    // pushState 不触发 hashchange，后退/前进只会触发 popstate
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, [setView]);

  // 浏览页 hash 同步：首次 replace，之后 push（后退才有页面可回）
  useEffect(() => {
    if (playRoute !== null || miniRoute !== null) return;
    const want = hashOf(view);
    if (location.hash === want) {
      booted.current = true;
      return;
    }
    const state = { horun: true, view };
    if (!booted.current) history.replaceState(state, '', want);
    else history.pushState(state, '', want);
    booted.current = true;
  }, [view, playRoute, miniRoute]);

  // Dock/顶部搜索切页走的是 store.setView，不会触发 hashchange；
  // 这里补上"当前浏览页"的记录，否则从推荐页进播放页会被记成进入前的剧场页。
  useEffect(() => {
    if (playRoute === null && miniRoute === null) lastView.current = view;
  }, [view, playRoute, miniRoute]);

  // 进播放页记来源，离开时清掉（下一部剧重新记）
  useEffect(() => {
    if (playRoute !== null) {
      if (!wasPlaying.current) rememberPlayOrigin(lastView.current);
      wasPlaying.current = true;
      return;
    }
    if (wasPlaying.current) {
      wasPlaying.current = false;
      clearPlayOrigin();
    }
  }, [playRoute]);

  // 切页面时自动收起详情（方案要求：详情抽屉不跨页残留）
  const refreshAccount = useApp((s) => s.refreshAccount);
  const detailId = useApp((s) => s.detailId);
  const closeDetail = useApp((s) => s.closeDetail);
  useEffect(() => {
    closeDetail();
  }, [view, closeDetail]);

  useEffect(() => {
    void refreshAccount();
  }, [refreshAccount]);

  // 启动时同步一次账号历史，首页「继续播放」才能直接对应账号进度
  useEffect(() => {
    void (async () => {
      try {
        const [acc, cfg] = await Promise.all([api.accountStatus(), api.settings()]);
        if (acc.loggedIn && cfg.autoSyncAccount !== false) await api.accountSync(false);
      } catch {
        /* 离线/未登录就不折腾 */
      }
    })();
  }, []);

  const View = VIEWS[view];

  // 小窗：只有迷你播放器，没有任何应用外壳
  if (miniRoute !== null) {
    return <MiniPlayer route={miniRoute} />;
  }

  // 播放页全屏：不显示顶栏 / 底部导航
  if (playRoute !== null) {
    return (
      <>
        <div className="backdrop" />
        <Play route={playRoute} />
        <RewardDialog />
        <ShareDialog />
        <UpdateCard />
      </>
    );
  }

  return (
    <>
      <div className="backdrop" />
      <div className="app">
        <TopBar />
        <main className="app__main" data-view={view}>
          <div className="view-stage" key={view}>
            <View />
          </div>
        </main>
        <Dock />
      </div>
      {detailId !== null && <DetailDrawer seriesId={detailId} />}
      <LoginDialog />
      <RewardDialog />
      <ShareDialog />
      <UpdateCard />
    </>
  );
}
