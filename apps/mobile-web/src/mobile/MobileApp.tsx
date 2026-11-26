import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { parsePlay, type PlayRoute } from '../routes.ts';
import { Play } from '../views/Play.tsx';
import { Feed } from '../views/Feed.tsx';
import { Detail } from './Detail.tsx';
import { TABS, hashOfRoute, parseRoute, type MRoute, NavContext } from './nav.tsx';
import { GlassDefs, Icon, Sheet } from './ui.tsx';
import { ShareDialog } from '../ui/ShareDialog.tsx';
import { About, Search } from './pages/Search.tsx';
import { Home } from './pages/Home.tsx';
import { Library } from './pages/Library.tsx';
import { Me } from './pages/Me.tsx';
import { MeSettings } from './pages/MeSettings.tsx';
import { Category, Downloads, NewReleases } from './pages/Misc.tsx';
import { Rank } from './pages/Rank.tsx';
import { useApp } from '../store.ts';
import { APP_VERSION, checkMobileUpdate, compareVersion } from '../app-info.ts';

const TAB_ROUTES: MRoute[] = TABS.map((t) => t.route);

const PAGES: Record<MRoute, () => JSX.Element> = {
  home: Home,
  feed: Feed,
  rank: Rank,
  library: Library,
  me: Me,
  settings: MeSettings,
  search: Search,
  about: About,
  new: NewReleases,
  category: Category,
  downloads: Downloads,
};

const LABEL: Record<MRoute, string> = {
  home: '剧场',
  feed: '推荐',
  rank: '榜单',
  library: '追剧',
  me: '我的',
  settings: '设置',
  search: '搜索',
  about: '关于',
  new: '新剧日历',
  category: '分类',
  downloads: '下载',
};

/**
 * 底栏：3 个纯文字 Tab（首页 / 剧场 / 我的），对齐官方新版。
 * 不做图标、不做药丸滑块——选中态只靠字重 + 1px 下划线。
 */
function TabBar({ route, onGo }: { route: MRoute; onGo: (next: MRoute) => void }): JSX.Element {
  return (
    <nav className="m-tabbar" aria-label="主导航">
      {TABS.map((tab) => (
        <button
          key={tab.route}
          type="button"
          className="m-tabbar__item"
          data-active={tab.route === route}
          aria-current={tab.route === route ? 'page' : undefined}
          onClick={() => {
            navigator.vibrate?.(6);
            onGo(tab.route);
          }}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}

export function MobileApp(): JSX.Element {
  const theme = useApp((s) => s.theme);
  const [route, setRoute] = useState<MRoute>(() => parseRoute(location.hash));
  const [playRoute, setPlayRoute] = useState<PlayRoute | null>(() => parsePlay(location.hash));
  const [detailId, setDetailId] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 视频相关路由：推荐流和播放页允许横屏，其他页面保持竖屏 */
  const videoRoute = playRoute !== null || route === 'feed';

  const sync = useCallback(() => {
    const nextPlay = parsePlay(location.hash);
    setPlayRoute(nextPlay);
    if (nextPlay !== null) return;
    const detailMatch = /^#\/series\/(.+)$/.exec(location.hash);
    if (detailMatch !== null && detailMatch[1] !== undefined) {
      setDetailId(decodeURIComponent(detailMatch[1]));
      return;
    }
    setDetailId(null);
    setRoute(parseRoute(location.hash));
  }, []);

  // APK 内每天自动检查一次更新：发现新版就后台四线程下载，完成后走系统安装器。
  // 浏览器里没有原桥，不触发；设置里可以关掉（horun-auto-update=0）。
  useEffect(() => {
    const native = window.HorunAndroid;
    if (native?.downloadUpdate === undefined) return;
    if (localStorage.getItem('horun-auto-update') === '0') return;
    const last = Number(localStorage.getItem('horun-auto-check') ?? '0');
    if (Number.isFinite(last) && Date.now() - last < 24 * 60 * 60 * 1000) return;
    const timer = window.setTimeout(() => {
      localStorage.setItem('horun-auto-check', String(Date.now()));
      void checkMobileUpdate()
        .then((info) => {
          if (compareVersion(info.latest, APP_VERSION) <= 0) return;
          if (localStorage.getItem('horun-update-tried') === info.latest) return;
          const asset = info.assets.find((item) => item.name.toLowerCase().endsWith('.apk'));
          if (asset === undefined) return;
          localStorage.setItem('horun-update-tried', info.latest);
          native.downloadUpdate?.(asset.url, asset.name || `HorunDrama-${info.latest}.apk`, asset.digest, 4);
          native.toast?.(`发现新版本 v${info.latest}，正在后台下载更新`);
        })
        .catch(() => undefined);
    }, 5000);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    sync();
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, [sync]);

  // 系统栏跟着页面和主题走：推荐/播放/深色页是黑底白字，浅色页是白底黑字
  useEffect(() => {
    const dark = playRoute !== null || route === 'feed' || theme === 'dark';
    window.HorunAndroid?.setBars?.(dark ? 'dark' : 'light');
  }, [route, playRoute, detailId, theme]);

  // 1.3.6：所有页面都允许横屏（不再只给推荐流/播放页）。
  // 沉浸式仍只给视频路由；普通页横屏时保留系统栏。
  useEffect(() => {
    window.HorunAndroid?.setOrientation?.('auto');
  }, []);

  // 横竖屏切换：给根节点打标记，驱动横屏布局 + 转场动画；横屏视频页同时进沉浸式全屏。
  useEffect(() => {
    const query = window.matchMedia('(orientation: landscape)');
    let rotateTimer: number | null = null;

    const apply = (animate: boolean): void => {
      const landscape = query.matches;
      const root = document.documentElement;
      root.classList.toggle('is-landscape', landscape);
      if (landscape && videoRoute) window.HorunAndroid?.setImmersive?.(true);
      else window.HorunAndroid?.setImmersive?.(false);
      if (!animate) return;
      root.classList.add('is-rotating');
      if (rotateTimer !== null) window.clearTimeout(rotateTimer);
      rotateTimer = window.setTimeout(() => {
        root.classList.remove('is-rotating');
        rotateTimer = null;
      }, 520);
    };

    apply(false);
    let lastLandscape = query.matches;
    const onChange = (): void => {
      const next = query.matches;
      apply(next !== lastLandscape);
      lastLandscape = next;
    };
    const onFullscreen = (): void => {
      if (query.matches && videoRoute) window.HorunAndroid?.setImmersive?.(true);
    };
    query.addEventListener?.('change', onChange);
    window.addEventListener('resize', onChange);
    window.addEventListener('orientationchange', onChange);
    document.addEventListener('fullscreenchange', onFullscreen);
    document.addEventListener('webkitfullscreenchange', onFullscreen);
    return () => {
      query.removeEventListener?.('change', onChange);
      window.removeEventListener('resize', onChange);
      window.removeEventListener('orientationchange', onChange);
      document.removeEventListener('fullscreenchange', onFullscreen);
      document.removeEventListener('webkitfullscreenchange', onFullscreen);
      document.documentElement.classList.remove('is-landscape', 'is-rotating');
      if (rotateTimer !== null) window.clearTimeout(rotateTimer);
    };
  }, [videoRoute]);

  const go = useCallback((next: MRoute) => {
    const hash = hashOfRoute(next);
    if (location.hash === hash) return;
    history.pushState({ m: true }, '', hash);
    setDetailId(null);
    setRoute(next);
  }, []);

  const back = useCallback(() => {
    if (window.history.length > 1 && history.state?.m === true) history.back();
    else go('home');
  }, [go]);

  const openDetail = useCallback((seriesId: string) => {
    setDetailId(seriesId);
    history.pushState({ detail: seriesId }, '', `#/series/${encodeURIComponent(seriesId)}`);
  }, []);

  const play = useCallback((seriesId: string, episodeId: string, no: number) => {
    history.pushState({ m: true }, '', `#/play/${seriesId}/${episodeId}/${no}`);
    setPlayRoute({ seriesId, episodeId, no, startAt: 0 });
  }, []);

  // 滚动监听：大标题滚走后顶栏出现小标题（iOS 大标题行为）
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const onScroll = (): void => setScrolled(el.scrollTop > 28);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [route]);

  // 进播放页/详情时把滚动位置留在原处，返回后恢复
  useEffect(() => {
    if (playRoute !== null) return;
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = 0;
  }, [route, playRoute]);

  const nav = useMemo(() => ({ route, go, back, openDetail, play, scrolled }), [route, go, back, openDetail, play, scrolled]);

  if (playRoute !== null) {
    return (
      <NavContext.Provider value={nav}>
        <GlassDefs />
        <div className="m-playwrap">
          <Play route={playRoute} mobile />
        </div>
        <ShareDialog />
      </NavContext.Provider>
    );
  }

  const Page = PAGES[route];
  const isTab = TAB_ROUTES.includes(route);

  return (
    <NavContext.Provider value={nav}>
      <GlassDefs />
      <div className="m-app" data-route={route} data-tab={isTab}>
        {/* Tab 页不设顶栏：内容直接顶到安全区；二级页固定 44dp 返回栏 + 居中 15sp 标题。
            搜索页自带「返回 + 搜索框 + 搜索」头部，不再叠一层通用顶栏。 */}
        {!isTab && route !== 'search' && (
          <header className="m-topbar" data-compact={scrolled || !isTab}>
            <button type="button" className="m-topbar__back" aria-label="返回" onClick={back}>
              <Icon name="back" size={19} />
            </button>
            <span className="m-topbar__title m-topbar__title--center">{LABEL[route]}</span>
            <span className="m-topbar__spacer" />
          </header>
        )}

        <div className="m-scroll" ref={scrollRef} data-immersive={route === 'feed'}>
          <div className="m-page" key={route}>
            <Page />
          </div>
        </div>

        {isTab && <TabBar route={route} onGo={go} />}

        <Sheet open={detailId !== null} onClose={() => history.back()} tall>
          {detailId !== null && <Detail seriesId={detailId} onOpen={openDetail} />}
        </Sheet>

        <ShareDialog />
      </div>
    </NavContext.Provider>
  );
}



