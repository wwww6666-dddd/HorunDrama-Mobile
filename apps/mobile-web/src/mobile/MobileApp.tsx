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
import { Category, Downloads, NewReleases } from './pages/Misc.tsx';
import { Rank } from './pages/Rank.tsx';

const TAB_ROUTES: MRoute[] = TABS.map((t) => t.route);

const PAGES: Record<MRoute, () => JSX.Element> = {
  home: Home,
  feed: Feed,
  rank: Rank,
  library: Library,
  me: Me,
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
  search: '搜索',
  about: '关于',
  new: '新剧日历',
  category: '分类',
  downloads: '下载',
};

/**
 * 底栏：4 个纯文字 Tab（阶段 A 口径）。
 * 不做图标、不做药丸滑块——选中态只靠字重 + 1px 下划线，跟官方一致。
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
  const [route, setRoute] = useState<MRoute>(() => parseRoute(location.hash));
  const [playRoute, setPlayRoute] = useState<PlayRoute | null>(() => parsePlay(location.hash));
  const [detailId, setDetailId] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    sync();
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, [sync]);

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
          <Play route={playRoute} />
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
        {/* Tab 页不设顶栏：内容直接顶到安全区；二级页固定 44dp 返回栏 + 居中 15sp 标题 */}
        {!isTab && (
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



