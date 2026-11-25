import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { createPortal } from 'react-dom';
import { CAN_PLAY_HEVC } from '../media-support.ts';
import { api, coverOf, type CommentItem, type DanmakuItem, type FeedItem, type FeedTab, type PlayJob } from '../api.ts';
import { useMaybeNav, type MRoute } from '../mobile/nav.tsx';
import { Icon, Sheet, type IconName } from '../mobile/ui.tsx';
import { useApp } from '../store.ts';
import { DanmakuLayer } from '../ui/DanmakuLayer.tsx';
import { DramaPlayer } from '../ui/DramaPlayer.tsx';
import { useDanmaku } from '../hooks/useDanmaku.ts';
import { useTilt } from '../hooks/useTilt.ts';
import { readDanmakuPrefs, writeDanmakuPrefs, type DanmakuPrefs } from '../settings/danmaku.ts';
import type Player from 'xgplayer';
import { IconDownload } from '../ui/icons.tsx';

function fmtCount(n: number | undefined): string {
  if (n === undefined || n <= 0) return '';
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
  return String(n);
}

function fmtCommentTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

/** 推荐页右侧评论图标：线性气泡，比 emoji 更贴手机端的白描风格。 */
function RailCommentIcon(): JSX.Element {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 5.5h16v10.5H10l-5 4v-4H4z" />
      <path d="M8 10.5h8M8 13h5" />
    </svg>
  );
}

const TABS: Array<{ name: string; tab: FeedTab }> = [
  { name: '关注', tab: 'follow' },
  { name: '漫剧', tab: 'anime' },
  { name: '真人剧', tab: 'live' },
  { name: '推荐', tab: 'recommend' },
];

/** 汉堡里的快捷入口（阶段 A）：榜单/下载等从底栏挪走后，在这里留一条通路。 */
const QUICK: Array<{ route: MRoute; label: string; icon: IconName }> = [
  { route: 'me', label: '我的', icon: 'me' },
  { route: 'search', label: '搜索', icon: 'search' },
  { route: 'rank', label: '榜单', icon: 'rank' },
  { route: 'downloads', label: '下载', icon: 'download' },
  { route: 'new', label: '新剧日历', icon: 'tv' },
  { route: 'category', label: '分类', icon: 'filter' },
];

/** 推荐流顶栏的汉堡 / 搜索图标：线宽和 mobile/ui 的 Icon 对齐。 */
function MenuGlyph(): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

function SearchGlyph(): JSX.Element {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16.5 16.5 21 21" />
    </svg>
  );
}

/** 左侧推荐卡：3D 倾斜放在内层，外层继续负责当前卡放大/滚动对齐。 */
function FeedSideCard({
  item,
  active,
  onSelect,
  itemRef,
}: {
  item: FeedItem;
  active: boolean;
  onSelect: () => void;
  itemRef: (el: HTMLButtonElement | null) => void;
}): JSX.Element {
  const tiltRef = useRef<HTMLSpanElement | null>(null);
  useTilt(tiltRef, { maxX: 10, maxY: 12, scale: 1, lift: -3 });
  return (
    <button
      ref={itemRef}
      type="button"
      className="feedv__side-card"
      data-active={active}
      onClick={onSelect}
      title={`${item.title} · 第 ${item.episodeNo} 集`}
    >
      <span ref={tiltRef} className="feedv__side-tilt">
        <span
          className="feedv__side-cover"
          style={{ backgroundImage: `url("${coverOf(item)}")` }}
          aria-hidden="true"
        />
        <span className="tilt-glare" aria-hidden="true" />
      </span>
    </button>
  );
}

/**
 * 推荐流：一屏一条，上下滑切换，当前条自动播。
 *
 * 左侧是同步滚动的推荐片单，中间是按真实比例缩放的视频舞台；
 * 右侧操作栏 / 底部信息 / 顶部推荐分类都保持沉浸式布局。
 */
export function Feed(): JSX.Element {
  /** 手机壳里才有的顶栏入口（汉堡 + 搜索）；桌面端不渲染 */
  const mob = useMaybeNav();
  const [menuOpen, setMenuOpen] = useState(false);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [tab, setTab] = useState<FeedTab>('recommend');
  const [slideDir, setSlideDir] = useState(1);
  const scrollerRef = useRef<HTMLDivElement>(null);
  /** 左侧推荐片单：跟随当前条自动滚动到可视区 */
  const sideListRef = useRef<HTMLDivElement | null>(null);
  const sideItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  /** 推荐页容器：全屏宿主 + 闲置隐藏的挂载点 */
  const feedRootRef = useRef<HTMLDivElement | null>(null);
  /** 播放设置（和剧场页共用同一份 settings.json） */
  const [rate, setRate] = useState(1);
  const [playPrefs, setPlayPrefs] = useState({ autoPlayNext: true, skipIntroSec: 0, skipOutroSec: 0 });
  const [chromeVisible, setChromeVisible] = useState(true);
  const chromeTimer = useRef<number | null>(null);
  /** 鼠标动一下就唤醒，闲置 2.6 秒后把操作栏/控制条一起收起来（弹幕保留） */
  const wake = useCallback((): void => {
    setChromeVisible(true);
    if (chromeTimer.current !== null) window.clearTimeout(chromeTimer.current);
    // 手机端推荐流顶栏（汉堡/频道/搜索）常驻，不像桌面播放器那样 2.6s 自动收
    if (mob !== null) return;
    chromeTimer.current = window.setTimeout(() => setChromeVisible(false), 2600);
  }, [mob]);
  useEffect(() => {
    wake();
    return () => {
      if (chromeTimer.current !== null) window.clearTimeout(chromeTimer.current);
    };
  }, [wake]);

  // 播放设置：进入推荐页读一次，控制条设置面板改了立即写回
  useEffect(() => {
    let alive = true;
    void api
      .settings()
      .then((s) => {
        if (!alive) return;
        setRate(s.defaultSpeed);
        setPlayPrefs({
          autoPlayNext: s.autoPlayNext,
          skipIntroSec: s.skipIntroSec,
          skipOutroSec: s.skipOutroSec,
        });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  /** 保存播放设置：本地先生效，再异步写核心。 */
  const patchPlayPrefs = (patch: Partial<typeof playPrefs> & { defaultSpeed?: number }): void => {
    setPlayPrefs((prev) => ({ ...prev, ...patch }));
    void api.saveSettings(patch).catch(() => undefined);
  };

  // 当前条变化时，把左侧片单里对应卡片滚到「和视频中线齐平」的位置。
  // 不能简单用列表中心：左侧还有标题、列表上下留白，列表中心比视频中心低。
  // 这里按当前视频 frame 的中心算 padding + scrollTop，窗口缩放时重新对齐。
  useEffect(() => {
    const list = sideListRef.current;
    const item = sideItemRefs.current[index];
    if (list === null || item === undefined || item === null) return;

    // 用 scrollTop 而不是 smooth：切集后视频宽高比/高度还会变，平滑滚动往往
    // 停在旧目标上，看起来就是"卡片没对齐"。这里立即对齐，再由下面的
    // ResizeObserver + 连续帧校正兜住视频 metadata 到达后的尺寸变化。
    list.style.scrollBehavior = 'auto';
    let raf = 0;
    let frames = 0;
    let observer: ResizeObserver | null = null;

    const align = (): void => {
      const frame = document.querySelector<HTMLElement>('.feedv__slide--active .feedv__frame');
      if (frame === null) return;
      const frameRect = frame.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      const cardH = item.offsetHeight;
      if (cardH <= 0) return;
      const frameCenter = frameRect.top + frameRect.height / 2;
      const padTop = Math.max(0, frameCenter - listRect.top - cardH / 2);
      const padBottom = Math.max(0, listRect.bottom - frameCenter - cardH / 2);
      list.style.paddingTop = `${Math.round(padTop)}px`;
      list.style.paddingBottom = `${Math.round(padBottom)}px`;
      // 改完 padding 后 offsetTop 会变，必须重新读一次
      const top = listRect.top + item.offsetTop + cardH / 2 - frameCenter;
      list.scrollTop = Math.max(0, top);
    };

    /** 连续 30 帧校正（约 0.5s），覆盖视频 metadata / 窗口尺寸落定过程。 */
    const tick = (): void => {
      align();
      frames += 1;
      raf = frames < 30 ? window.requestAnimationFrame(tick) : 0;
    };
    raf = window.requestAnimationFrame(tick);

    const frame = document.querySelector<HTMLElement>('.feedv__slide--active .feedv__frame');
    if (frame !== null && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => align());
      observer.observe(frame);
    }
    const onResize = (): void => align();
    window.addEventListener('resize', onResize);
    return () => {
      if (raf !== 0) window.cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [index, items.length]);
  const cursorRef = useRef('');
  const loadingRef = useRef(false);
  const noteTimer = useRef<number | null>(null);
  const [commentTarget, setCommentTarget] = useState<FeedItem | null>(null);
  const [commentItems, setCommentItems] = useState<CommentItem[]>([]);
  const [commentCursor, setCommentCursor] = useState('');
  const [commentHasMore, setCommentHasMore] = useState(false);
  const [commentTotal, setCommentTotal] = useState(0);
  const [commentLoading, setCommentLoading] = useState(false);
  const [commentError, setCommentError] = useState('');
  const [commentText, setCommentText] = useState('');
  const [commentSending, setCommentSending] = useState(false);
  const [replyState, setReplyState] = useState<
    Record<string, { items: CommentItem[]; cursor: string; hasMore: boolean; loading: boolean; open: boolean }>
  >({});
  const account = useApp((s) => s.account);

  const flash = useCallback((text: string) => {
    setNote(text);
    if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(''), 2200);
  }, []);

  const loadComments = async (item: FeedItem, cursor = ''): Promise<void> => {
    setCommentLoading(true);
    setCommentError('');
    try {
      const page = await api.comments({
        seriesId: item.seriesId,
        episodeId: item.episodeId,
        cursor,
        count: 20,
      });
      setCommentItems((prev) => (cursor === '' ? page.items : [...prev, ...page.items]));
      setCommentCursor(page.cursor);
      setCommentHasMore(page.hasMore);
      if (cursor === '') setCommentTotal(page.total);
    } catch (err) {
      setCommentError((err as Error).message);
    } finally {
      setCommentLoading(false);
    }
  };

  const openComments = (item: FeedItem): void => {
    setCommentTarget(item);
    setCommentItems([]);
    setCommentCursor('');
    setCommentHasMore(false);
    setCommentError('');
    setCommentText('');
    setCommentTotal(item.commentCount);
    void loadComments(item, '');
  };

  const likeComment = async (item: CommentItem): Promise<void> => {
    const next = !item.liked;
    setCommentItems((prev) =>
      prev.map((row) =>
        row.id === item.id
          ? { ...row, liked: next, likeCount: Math.max(0, row.likeCount + (next ? 1 : -1)) }
          : row,
      ),
    );
    try {
      await api.likeComment({ commentId: item.id, liked: next });
    } catch (err) {
      setCommentItems((prev) =>
        prev.map((row) =>
          row.id === item.id ? { ...row, liked: item.liked, likeCount: item.likeCount } : row,
        ),
      );
      flash(`点赞失败：${(err as Error).message}`);
    }
  };

  const removeComment = async (item: CommentItem): Promise<void> => {
    if (commentTarget === null) return;
    try {
      await api.deleteComment({ commentId: item.id, episodeId: commentTarget.episodeId });
      setCommentItems((prev) => prev.filter((row) => row.id !== item.id));
      setCommentTotal((n) => Math.max(0, n - 1));
      flash('评论已删除');
    } catch (err) {
      setCommentError((err as Error).message);
    }
  };

  const loadReplies = async (item: CommentItem, cursor = ''): Promise<void> => {
    if (commentTarget === null) return;
    setReplyState((prev) => ({
      ...prev,
      [item.id]: {
        items: prev[item.id]?.items ?? [],
        cursor: prev[item.id]?.cursor ?? '',
        hasMore: prev[item.id]?.hasMore ?? false,
        loading: true,
        open: true,
      },
    }));
    try {
      const page = await api.replies({
        seriesId: commentTarget.seriesId,
        episodeId: commentTarget.episodeId,
        commentId: item.id,
        cursor,
      });
      setReplyState((prev) => {
        const current = prev[item.id];
        return {
          ...prev,
          [item.id]: {
            items: cursor === '' ? page.items : [...(current?.items ?? []), ...page.items],
            cursor: page.cursor,
            hasMore: page.hasMore,
            loading: false,
            open: true,
          },
        };
      });
    } catch (err) {
      setCommentError(`回复加载失败：${(err as Error).message}`);
      setReplyState((prev) => ({
        ...prev,
        [item.id]: { items: [], cursor: '', hasMore: false, loading: false, open: false },
      }));
    }
  };

  const toggleReplies = (item: CommentItem): void => {
    const current = replyState[item.id];
    if (current?.open === true) {
      setReplyState((prev) => ({ ...prev, [item.id]: { ...current, open: false } }));
      return;
    }
    if (current !== undefined && current.items.length > 0) {
      setReplyState((prev) => ({ ...prev, [item.id]: { ...current, open: true } }));
      return;
    }
    void loadReplies(item, '');
  };

  const sendComment = async (): Promise<void> => {    const target = commentTarget;
    const text = commentText.trim();
    if (target === null || text === '') return;
    setCommentSending(true);
    setCommentError('');
    try {
      const res = await api.sendComment({
        seriesId: target.seriesId,
        episodeId: target.episodeId,
        text,
      });
      const item: CommentItem = {
        id: res.commentId !== '' ? res.commentId : `local-${Date.now()}`,
        text,
        user: {
          userId: account?.userId ?? '',
          name: account?.nickname !== undefined && account.nickname !== '' ? account.nickname : '我',
          avatar: account?.avatar ?? '',
        },
        likeCount: 0,
        liked: false,
        replyCount: 0,
        createTime: Math.floor(Date.now() / 1000),
        offsetTime: 0,
      };
      setCommentItems((prev) => [item, ...prev]);
      setCommentTotal((n) => n + 1);
      setCommentText('');
    } catch (err) {
      setCommentError((err as Error).message);
    } finally {
      setCommentSending(false);
    }
  };

  const load = useCallback(
    async (reset: boolean, refresh = false) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      if (reset) setLoading(true);
      try {
        const res = await api.feed(reset ? '' : cursorRef.current, tab, refresh);
        cursorRef.current = res.cursor;
        setHasMore(res.hasMore);
        setItems((prev) => {
          if (reset) return res.items;
          const seen = new Set(prev.map((item) => item.seriesId));
          return [...prev, ...res.items.filter((item) => !seen.has(item.seriesId))];
        });
        if (reset) {
          setIndex(0);
          window.requestAnimationFrame(() => {
            scrollerRef.current?.scrollTo({ top: 0 });
          });
        }
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        loadingRef.current = false;
        setLoading(false);
        setLoadedOnce(true);
        setSwitching(false);
      }
    },
    [tab],
  );

  useEffect(() => {
    setIndex(0);
    cursorRef.current = '';
    scrollerRef.current?.scrollTo({ top: 0 });
    void load(true, false);
  }, [load]);

  // 连续刷集不等待：在这一条停留 2.5s 后，把**下一条**的 360p 地址预热好，
  // 高清也在后台起任务（和电脑端播放页 25s 时的 prewarm + startUpgrade 同一思路）。
  // 快速划走就取消，避免一排后台转码把当前这集挤到最后。
  useEffect(() => {
    const next = items[index + 1];
    if (next === undefined) return;
    const quality = localStorage.getItem('horun-quality') ?? '1080p';
    const timer = window.setTimeout(() => {
      void api.prewarm(next.episodeId).catch(() => undefined);
      void api
        .startUpgrade(next.episodeId, quality === '' ? '1080p' : quality, CAN_PLAY_HEVC)
        .catch(() => undefined);
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [index, items]);

  const scrollTo = (i: number): void => {
    const el = scrollerRef.current;
    if (el !== null) el.scrollTo({ top: i * el.clientHeight, behavior: 'smooth' });
  };

  const onScroll = (): void => {
    const el = scrollerRef.current;
    if (el === null) return;
    const i = Math.round(el.scrollTop / Math.max(1, el.clientHeight));
    if (i !== index) setIndex(i);
    if (hasMore && i >= items.length - 3) void load(false);
  };

  const next = (): void => {
    if (index + 1 < items.length) scrollTo(index + 1);
    else if (hasMore) void load(false);
  };

  const prev = (): void => {
    if (index > 0) scrollTo(index - 1);
  };

  const removeAt = (i: number): void => {
    setItems((prev) => prev.filter((_, j) => j !== i));
    if (i < index) setIndex((n) => Math.max(0, n - 1));
    flash('已减少此类推荐');
  };

  const handleTab = (next: FeedTab): void => {
    if (next === tab) {
      if (next === 'recommend') {
        void load(true, true);
        scrollerRef.current?.scrollTo({ top: 0 });
      }
      return;
    }
    setSwitching(true);
    document.querySelectorAll<HTMLVideoElement>('.feedv video').forEach((video) => video.pause());
    setSlideDir(
      TABS.findIndex((entry) => entry.tab === next) >= TABS.findIndex((entry) => entry.tab === tab)
        ? 1
        : -1,
    );
    setTab(next);
  };

  // 手机端首屏：16:9 画框 + 两行信息骨架，顶部 Tab 始终可见（官方同款）
  if (mob !== null && loading && items.length === 0 && !loadedOnce) {
    return (
      <div className="feedv feedv--loading">
        <div className="m-feedtop">
          <button type="button" className="m-feedtop__btn" aria-label="快捷入口" onClick={() => setMenuOpen(true)}>
            <MenuGlyph />
          </button>
          <button type="button" className="m-feedtop__btn" aria-label="搜索" onClick={() => mob.go('search')}>
            <SearchGlyph />
          </button>
        </div>
        <div className="feedv__sk" aria-hidden="true">
          <div className="feedv__sk-media feedv__sk-block" />
          <div className="feedv__sk-line feedv__sk-line--1 feedv__sk-block" />
          <div className="feedv__sk-line feedv__sk-line--2 feedv__sk-block" />
        </div>
        <div className="feedv__tabs">
          {TABS.map((entry) => (
            <button
              key={entry.tab}
              className="feedv__tab"
              data-active={entry.tab === tab}
              onClick={() => handleTab(entry.tab)}
            >
              {entry.name}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (loading && items.length === 0 && !loadedOnce) {
    return (
      <div className="feedv feedv--state">
        <div className="feedv__spinner" />
        <p>正在准备推荐流…</p>
      </div>
    );
  }

  if (error !== null && items.length === 0 && !loadedOnce) {
    return (
      <div className="feedv feedv--state">
        <p>推荐流加载失败：{error}</p>
        <button className="btn btn--primary" onClick={() => void load(true)}>
          重试
        </button>
      </div>
    );
  }

  return (
    <div
      className="feedv"
      ref={feedRootRef}
      data-chrome-hidden={!chromeVisible}
      onMouseMove={wake}
      onClick={wake}
      onTouchStart={wake}
    >
      {/* 手机端顶栏（阶段 A）：汉堡 + 居中频道 + 搜索，全部浮在视频上 */}
      {mob !== null && (
        <div className="m-feedtop" data-hidden={!chromeVisible}>
          <button type="button" className="m-feedtop__btn" aria-label="快捷入口" onClick={() => setMenuOpen(true)}>
            <MenuGlyph />
          </button>
          <button type="button" className="m-feedtop__btn" aria-label="搜索" onClick={() => mob.go('search')}>
            <SearchGlyph />
          </button>
        </div>
      )}

      {/* 左侧推荐片单：补上视频缩小后空出来的位置；当前条高亮并自动滚到中间 */}
      <aside className="feedv__side" aria-label="推荐片单">
        <div className="feedv__side-head">
          <strong>推荐片单</strong>
          <span>
            {items.length > 0 ? `${Math.min(index + 1, items.length)} / ${items.length}` : '—'}
          </span>
        </div>
        <div className="feedv__side-list" ref={sideListRef}>
          {items.map((item, i) => (
            <FeedSideCard
              key={item.seriesId}
              item={item}
              active={i === index}
              onSelect={() => scrollTo(i)}
              itemRef={(el) => {
                sideItemRefs.current[i] = el;
              }}
            />
          ))}
        </div>
      </aside>

      <div className="feedv__stage">
        <div
          className="feedv__scroller"
          key={tab}
          ref={scrollerRef}
          onScroll={onScroll}
          style={{ ['--slide-dir' as string]: slideDir }}
        >
          {items.map((item, i) => (
            <FeedSlide
              key={item.seriesId}
              item={item}
              kind={tab === 'anime' ? '漫剧' : tab === 'live' ? '真人剧' : (item.tags[0] ?? '短剧')}
              active={i === index}
              rate={rate}
              playPrefs={playPrefs}
              onRate={(value) => {
                setRate(value);
                patchPlayPrefs({ defaultSpeed: value });
              }}
              onToggleAutoNext={() => patchPlayPrefs({ autoPlayNext: !playPrefs.autoPlayNext })}
              onSkipIntro={(value) => patchPlayPrefs({ skipIntroSec: value })}
              onSkipOutro={(value) => patchPlayPrefs({ skipOutroSec: value })}
              onPrev={prev}
              onNext={next}
              onNote={flash}
              onRemove={() => removeAt(i)}
              onComments={() => openComments(item)}
              fullscreenHost={() => feedRootRef.current}
            />
          ))}
          {hasMore && (
            <div className="feedv__more">
              <div className="feedv__spinner" />
              <p>继续加载…</p>
            </div>
          )}
          {!hasMore && items.length > 0 && <div className="feedv__more">没有更多了</div>}
          {!loading && items.length === 0 && (
            <div className="feedv__more">
              {tab === 'follow' ? '还没有追更的剧，先去追几部' : '当前分类暂无内容'}
            </div>
          )}
        </div>

        {switching && error === null && (
          <div className="feedv__tab-loading">
            <div className="feedv__spinner" />
            <p>切换中…</p>
          </div>
        )}
        {error !== null && (
          <div className="feedv__tab-loading">
            <p>{error}</p>
            <button className="btn" onClick={() => void load(true)}>
              重试
            </button>
          </div>
        )}

        <div className="feedv__tabs">
          {TABS.map((entry) => (
            <button
              key={entry.tab}
              className="feedv__tab"
              data-active={entry.tab === tab}
              onClick={() => handleTab(entry.tab)}
            >
              {entry.name}
            </button>
          ))}
        </div>
      </div>

      {commentTarget !== null && (
        <div className="play__comments-mask" role="presentation" onClick={() => setCommentTarget(null)}>
          <aside className="play__comments" role="dialog" aria-label="评论" onClick={(e) => e.stopPropagation()}>
            <header className="play__comments-head">
              <strong>评论</strong>
              <span>{fmtCount(commentTotal) || '0'} 条</span>
              <button className="btn btn--ghost btn--icon" onClick={() => setCommentTarget(null)} aria-label="关闭">
                ✕
              </button>
            </header>
            <div className="play__comment-compose">
              <input
                className="play__comment-input"
                placeholder="说点什么..."
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void sendComment();
                }}
              />
              <button
                className="btn btn--primary"
                disabled={commentSending || commentText.trim() === ''}
                onClick={() => void sendComment()}
              >
                {commentSending ? '发送中…' : '发送'}
              </button>
            </div>
            <div className="play__comments-body">
              {commentLoading && commentItems.length === 0 && <p className="play__comments-hint">正在加载评论…</p>}
              {commentError !== '' && <p className="play__comments-hint">加载失败：{commentError}</p>}
              {commentItems.map((item) => {
                const replies = replyState[item.id];
                return (
                  <div className="play__comment-thread" key={item.id}>
                    <article className="play__comment">
                      {item.user.avatar !== '' ? (
                        <img className="play__comment-avatar" src={item.user.avatar} alt="" loading="lazy" />
                      ) : (
                        <span className="play__comment-avatar play__comment-avatar--empty" />
                      )}
                      <div className="play__comment-main">
                        <p className="play__comment-name">{item.user.name}</p>
                        <p className="play__comment-text">{item.text}</p>
                        <p className="play__comment-meta">
                          {fmtCommentTime(item.createTime)}
                          {item.replyCount > 0 && ` · 回复 ${item.replyCount}`}
                        </p>
                        <button
                          className="play__comment-like"
                          data-on={item.liked}
                          onClick={() => void likeComment(item)}
                          aria-label={item.liked ? '取消点赞' : '点赞'}
                        >
                          <span>♥</span>
                          {fmtCount(item.likeCount) || '赞'}
                        </button>
                        {account?.userId === item.user.userId && (
                          <button className="play__comment-del" onClick={() => void removeComment(item)}>
                            删除
                          </button>
                        )}
                      </div>
                    </article>
                    {item.replyCount > 0 && (
                      <div className="play__reply-block">
                        <button className="play__reply-toggle" onClick={() => toggleReplies(item)}>
                          {replies?.open === true
                            ? '收起回复'
                            : replies?.loading === true
                              ? '加载中…'
                              : `展开 ${item.replyCount} 条回复`}
                        </button>
                        {replies?.open === true &&
                          replies.items.map((reply) => (
                            <div className="play__comment play__comment--reply" key={reply.id}>
                              {reply.user.avatar !== '' ? (
                                <img
                                  className="play__comment-avatar play__comment-avatar--small"
                                  src={reply.user.avatar}
                                  alt=""
                                  loading="lazy"
                                />
                              ) : (
                                <span className="play__comment-avatar play__comment-avatar--small play__comment-avatar--empty" />
                              )}
                              <div className="play__comment-main">
                                <p className="play__comment-name">{reply.user.name}</p>
                                <p className="play__comment-text">{reply.text}</p>
                              </div>
                            </div>
                          ))}
                        {replies?.open === true && replies.hasMore && (
                          <button
                            className="play__reply-toggle"
                            disabled={replies.loading}
                            onClick={() => void loadReplies(item, replies.cursor)}
                          >
                            {replies.loading ? '加载中…' : '更多回复'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {commentHasMore && (
                <button
                  className="btn btn--ghost play__comments-more"
                  disabled={commentLoading}
                  onClick={() => {
                    if (commentTarget !== null) void loadComments(commentTarget, commentCursor);
                  }}
                >
                  {commentLoading ? '加载中…' : '加载更多'}
                </button>
              )}
            </div>
          </aside>
        </div>
      )}

      {mob !== null && (
        <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title="快捷入口">
          <div className="m-quickgrid">
            {QUICK.map((entry) => (
              <button
                key={entry.route}
                type="button"
                className="m-quickgrid__item"
                onClick={() => {
                  setMenuOpen(false);
                  mob.go(entry.route);
                }}
              >
                <Icon name={entry.icon} size={20} />
                <span>{entry.label}</span>
              </button>
            ))}
          </div>
        </Sheet>
      )}

      {note !== '' && <div className="feedv__toast">{note}</div>}
    </div>
  );
}

interface SlideProps {
  item: FeedItem;
  /** 剧集条前缀：漫剧 / 真人剧 / 标签首项 / 短剧 */
  kind: string;
  active: boolean;
  rate: number;
  playPrefs: { autoPlayNext: boolean; skipIntroSec: number; skipOutroSec: number };
  onRate: (value: number) => void;
  onToggleAutoNext: () => void;
  onSkipIntro: (value: number) => void;
  onSkipOutro: (value: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onNote: (text: string) => void;
  onRemove: () => void;
  onComments: () => void;
  /** 全屏宿主：传推荐页容器，全屏后右侧操作栏/弹幕才不会消失 */
  fullscreenHost?: () => HTMLElement | null;
}

function FeedSlide({
  item,
  kind,
  active,
  rate,
  playPrefs,
  onRate,
  onToggleAutoNext,
  onSkipIntro,
  onSkipOutro,
  onPrev,
  onNext,
  onNote,
  onRemove,
  onComments,
  fullscreenHost,
}: SlideProps): JSX.Element {
  const mob = useMaybeNav();
  const storeOpenDetail = useApp((s) => s.openDetail);
  // 手机壳里没有桌面端的详情状态，必须走手机端自己的抽屉
  const openDetail = mob !== null ? mob.openDetail : storeOpenDetail;
  const [job, setJob] = useState<PlayJob | null>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [localDanmaku, setLocalDanmaku] = useState<DanmakuItem[]>([]);
  const [danmakuText, setDanmakuText] = useState('');
  const [danmakuPrefs, setDanmakuPrefs] = useState<DanmakuPrefs>(() => readDanmakuPrefs());
  const [time, setTime] = useState(0);
  const [liked, setLiked] = useState(false);
  const [digg, setDigg] = useState(item.diggCount);
  const [favorited, setFavorited] = useState(false);
  /** 追剧状态：官方头像下的「+」就是追剧；没有作者字段，用封面当头像不伪造人 */
  const [following, setFollowing] = useState(false);
  const [introOpen, setIntroOpen] = useState(false);
  /** 清晰度和播放页共用同一个偏好（localStorage: horun-quality） */
  const [quality, setQuality] = useState<string>(() => localStorage.getItem('horun-quality') ?? '1080p');
  const [qualityNonce, setQualityNonce] = useState(0);
  /** 切清晰度/等准备时的轻量提示；不卸载播放器、不中断当前画面 */
  const [qualityBusy, setQualityBusy] = useState(false);
  /** 自动升高清中：先播 360p，高清转好再换源 */
  const [autoHd, setAutoHd] = useState(false);
  /** 起播点：切清晰度时保留当前位置；换集时归零 */
  const [startAt, setStartAt] = useState(0);
  /** 当前视频宽高比：竖屏短剧 / 横屏短剧都按真实比例贴合 */
  const [aspect, setAspect] = useState(16 / 9);
  const slideRef = useRef<HTMLElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const lastEpisode = useRef('');
  const qualitySeek = useRef<number | null>(null);
  const timeRef = useRef(0);
  const playerRef = useRef<Player | null>(null);

  /** 切换清晰度：记住当前位置，旧画面继续播，等新流就绪后原地换源。 */
  const switchQuality = (next: string): void => {
    if (timeRef.current > 1) qualitySeek.current = timeRef.current;
    setQuality(next);
    setQualityNonce((n) => n + 1);
    if (next === '') localStorage.removeItem('horun-quality');
    else localStorage.setItem('horun-quality', next);
  };

  // 量一下这一屏可用尺寸：视频缩到合适大小，进度条/控制条才会贴着画面
  useEffect(() => {
    const el = slideRef.current;
    if (el === null) return;
    const measure = (): void => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * 当前条才起播；离开就卸载播放器并取消轮询。
   *
   * 和剧场播放页走**完全相同**的取流顺序（wait=1：优先本地 mp4 / 等转码完成），
   * 不再用 `live=1` 的秒开流 —— 那是 1.1.x 推荐页有时 360p、剧场页却秒开 1080p
   * 的根因。quality 变化时不卸载播放器，只在就绪后原地换源并保留进度。
   */
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const episodeChanged = lastEpisode.current !== item.episodeId;
    lastEpisode.current = item.episodeId;
    setError('');
    if (episodeChanged) {
      setUrl('');
      setJob(null);
      setTime(0);
      timeRef.current = 0;
      setStartAt(0);
      qualitySeek.current = null;
      setAspect(16 / 9);
    } else if (qualitySeek.current !== null) {
      setStartAt(qualitySeek.current);
      qualitySeek.current = null;
    }
    setQualityBusy(true);

    /** 高清起不来时退官网 360p 直连，至少能接着看（和播放页一致）。 */
    const fallbackSmooth = async (): Promise<boolean> => {
      const fallback = await api.play(item.episodeId, 'smooth', false, false, false, false).catch(() => null);
      if (cancelled) return true;
      if (fallback !== null && fallback.state === 'ready' && fallback.url !== '') {
        setJob(fallback);
        setUrl(fallback.url);
        setQualityBusy(false);
        onNote('高清没准备好，先用流畅线路播放（可拖动）');
        return true;
      }
      return false;
    };

    void (async () => {
      /** 已经先播上 360p？高清失败时就不用再退一次。 */
      let smoothShown = false;
      try {
        // 推荐流是"刷"的场景：等本地 1080p 转码 10s+ 才出画面没人受得了。
        // 第一步只拿官网 360p 直连（本地代理，几十毫秒就 ready），先把画面放出来。
        const smooth = await api
          .play(item.episodeId, 'smooth', false, false, false, false)
          .catch(() => null);
        if (cancelled) return;
        if (smooth !== null && smooth.state === 'ready' && smooth.url !== '') {
          smoothShown = true;
          setUrl(smooth.url);
          setQualityBusy(false);
        } else {
          setQualityBusy(true);
        }

        if (quality === 'smooth') {
          if (!smoothShown) setError('这一集暂时取不到流，稍后重试');
          return;
        }

        // 快速划走就别起转码任务，免得一排后台任务把当前这集的高清挤到最后（1.2s 足够判断"停留"）
        if (smoothShown) {
          setAutoHd(true);
          await sleep(1200);
          if (cancelled) return;
        }

        // 高清只起任务，不动正在播的 360p；就绪后原地换源。用 startUpgrade 而不是
        // play(wait=1)：后者会在服务端长轮询到转码结束才返回，等于把"秒开"抵消掉。
        const hd = await api.startUpgrade(item.episodeId, quality, CAN_PLAY_HEVC).catch(() => null);
        if (cancelled) return;
        if (hd === null) {
          setQualityBusy(false);
          setAutoHd(false);
          if (smoothShown) onNote('高清线路暂时取不到，先看流畅线路');
          else setError('这一集准备失败，稍后重试');
          return;
        }
        setJob(hd);
        let current = hd;
        while (!cancelled && current.state !== 'ready' && current.state !== 'failed') {
          await sleep(1200);
          if (cancelled) return;
          current = await api.prepare(current.jobId);
          if (cancelled) return;
          setJob(current);
        }
        if (cancelled) return;
        if (current.state === 'ready') {
          // 从 360p 换到高清：先把当前位置写进 startAt，XgPlayer 在 canplay 时 seek 回来
          if (timeRef.current > 1) setStartAt(timeRef.current);
          setJob(current);
          setUrl(current.url);
          setQualityBusy(false);
          setAutoHd(false);
        } else {
          setQualityBusy(false);
          setAutoHd(false);
          if (smoothShown) {
            onNote('高清没准备好，先看流畅线路');
            return;
          }
          if (!(await fallbackSmooth())) {
            setError(current.error !== '' ? current.error : '这一集准备失败');
          }
        }
      } catch (err) {
        if (cancelled) return;
        setQualityBusy(false);
        setAutoHd(false);
        if (!smoothShown && !(await fallbackSmooth())) setError((err as Error).message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [active, item.episodeId, retry, quality, qualityNonce, onNote]);

  useEffect(() => {
    setDigg(item.diggCount);
  }, [item.seriesId, item.diggCount]);

  const { items: remoteDanmaku } = useDanmaku({
    seriesId: item.seriesId,
    episodeId: item.episodeId,
    enabled: danmakuPrefs.enabled,
    ready: url !== '',
    timeMs: Math.round(time * 1000),
  });

  useEffect(() => {
    try {
      const raw = localStorage.getItem(`horun-danmaku:${item.episodeId}`);
      setLocalDanmaku(raw === null ? [] : (JSON.parse(raw) as DanmakuItem[]));
    } catch {
      setLocalDanmaku([]);
    }
  }, [item.episodeId]);

  const shownDanmaku = useMemo(
    () => [...remoteDanmaku, ...localDanmaku],
    [remoteDanmaku, localDanmaku],
  );

  const sendDanmaku = async (): Promise<void> => {
    const text = danmakuText.trim();
    if (text === '') return;
    try {
      const res = await api.sendDanmaku({
        seriesId: item.seriesId,
        episodeId: item.episodeId,
        text,
        offsetMs: Math.round(time * 1000),
      });
      const entry: DanmakuItem = {
        id: res.commentId !== '' ? res.commentId : `remote-${Date.now()}`,
        text,
        offsetMs: Math.round(time * 1000),
        likes: 0,
      };
      setLocalDanmaku((prev) => [...prev, entry]);
      setDanmakuText('');
      onNote('弹幕已发送');
    } catch (err) {
      onNote(`弹幕发送失败：${(err as Error).message}`);
    }
  };

  useEffect(() => {
    if (!active) return;
    void api.likeFor(item.seriesId).then((r) => setLiked(r.liked)).catch(() => undefined);
    void api.favoriteFor(item.seriesId).then((r) => setFavorited(r.favorite)).catch(() => undefined);
    void api.followFor(item.seriesId).then((r) => setFollowing(r.following)).catch(() => undefined);
  }, [active, item.seriesId]);

  const goPlay = (): void => {
    location.hash = `#/play/${item.seriesId}/${item.episodeId}/${item.episodeNo}`;
  };

  const toggleLike = async (): Promise<void> => {
    try {
      const res = await api.toggleLike({
        seriesId: item.seriesId,
        seriesTitle: item.title,
        cover: item.cover,
        episodeCount: item.episodeCount,
        episodeId: item.episodeId,
      });
      setLiked(res.liked);
      setDigg((n) => Math.max(0, n + (res.liked ? 1 : -1)));
    } catch (err) {
      onNote(`点赞失败：${(err as Error).message}`);
    }
  };

  const toggleFavorite = async (): Promise<void> => {
    try {
      const res = await api.toggleFavorite({
        seriesId: item.seriesId,
        seriesTitle: item.title,
        cover: item.cover,
        episodeCount: item.episodeCount,
      });
      setFavorited(res.added);
    } catch (err) {
      onNote(`收藏失败：${(err as Error).message}`);
    }
  };

  const toggleFollow = async (): Promise<void> => {
    try {
      const res = await api.toggleFollow({
        seriesId: item.seriesId,
        seriesTitle: item.title,
        cover: item.cover,
        episodeCount: item.episodeCount,
      });
      setFollowing(res.following);
      onNote(res.following ? '已加入追剧' : '已取消追剧');
    } catch (err) {
      onNote(`追剧失败：${(err as Error).message}`);
    }
  };

  const share = async (): Promise<void> => {
    const link = `https://novelquickapp.com/hongguo/ug/pages/video-animation-share?book_id=${item.seriesId}&video_id=${item.episodeId}`;
    try {
      await navigator.clipboard.writeText(link);
      onNote('红果分享链接已复制');
    } catch {
      onNote(link);
    }
  };

  const download = async (): Promise<void> => {
    try {
      await api.addDownloads({
        seriesId: item.seriesId,
        seriesTitle: item.title,
        cover: item.cover,
        episodes: [{ episodeId: item.episodeId, no: item.episodeNo }],
      });
      onNote('已加入下载');
    } catch (err) {
      onNote(`下载失败：${(err as Error).message}`);
    }
  };

  const ready = url !== '';
  const waiting = active && !ready && error === '';
  /** 底部细进度线：只有拿到时长才画，直连流时长可能是 0 */
  const progress = job !== null && job.durationSec > 0 ? Math.min(1, Math.max(0, time / job.durationSec)) : 0;

  // 按真实视频比例把画面装进舞台：横屏 16:9、竖屏 9:16 都不会把控制条拉成全宽
  const frameStyle = useMemo(() => {
    const availW = Math.max(240, box.w - 56);
    const availH = Math.max(180, box.h - 168);
    const ratio = Number.isFinite(aspect) && aspect > 0.2 && aspect < 5 ? aspect : 16 / 9;
    let width = Math.min(availW, availH * ratio);
    let height = width / ratio;
    if (height > availH) {
      height = availH;
      width = height * ratio;
    }
    return { width: `${Math.round(width)}px`, height: `${Math.round(height)}px` };
  }, [box, aspect]);

  /** 收到播放器后探测视频真实宽高，竖屏短剧也能正确贴合。 */
  const onReady = (p: Player): void => {
    playerRef.current = p;
    const media = p.media as HTMLVideoElement | null;
    if (media === null) return;
    const update = (): void => {
      if (media.videoWidth > 0 && media.videoHeight > 0) setAspect(media.videoWidth / media.videoHeight);
    };
    media.addEventListener('loadedmetadata', update);
    update();
  };

  /** 弹幕偏好：写 localStorage 并立即刷新当前页。 */
  const patchDanmaku = (patch: Partial<DanmakuPrefs>): void => {
    setDanmakuPrefs(writeDanmakuPrefs(patch));
  };

  return (
    <section className={`feedv__slide${active ? ' feedv__slide--active' : ''}`} ref={slideRef}>
      <div className="feedv__frame" style={frameStyle} data-portrait={aspect < 1}>
        <div className="feedv__poster" style={{ backgroundImage: `url("${item.cover}")` }} aria-hidden="true" />
        {active && url !== '' && (
          <DramaPlayer
            fullscreenHost={fullscreenHost}
            url={url}
            startAt={startAt}
            rate={rate}
            onReady={onReady}
            onPrev={onPrev}
            onNext={onNext}
            onTime={(t) => {
              timeRef.current = t;
              setTime(t);
            }}
            onPlaying={setPlaying}
            onEnded={() => {
              if (playPrefs.autoPlayNext) onNext();
            }}
            onError={(msg) => setError(msg)}
            extras={{
              episodeCount: item.episodeCount,
              qualities: job?.available ?? [],
              quality,
              definition: job?.definition,
              rate,
              onRate,
              autoPlayNext: playPrefs.autoPlayNext,
              onToggleAutoNext,
              skipIntroSec: playPrefs.skipIntroSec,
              skipOutroSec: playPrefs.skipOutroSec,
              onSkipIntro,
              onSkipOutro,
              onEpisodes: goPlay,
              onQuality: switchQuality,
              danmakuEnabled: danmakuPrefs.enabled,
              danmakuPrefs,
              onDanmakuPrefs: patchDanmaku,
              danmakuText,
              onToggleDanmaku: () => patchDanmaku({ enabled: !danmakuPrefs.enabled }),
              onDanmakuText: setDanmakuText,
              onSendDanmaku: () => void sendDanmaku(),
            }}
          />
        )}
        <div className="feedv__shade" aria-hidden="true" />

        {/* 手机端照官方：剧名压在画面右上、作者头像+追剧「+」、收藏落在画面右下、底部细进度线 */}
        {mob !== null && (
          <>
            <p className="feedv__vt-title">《{item.title}》</p>
            <div className="feedv__author">
              <div className="feedv__author-pic" style={{ backgroundImage: `url("${item.cover}")` }}>
                <button
                  type="button"
                  className="feedv__author-add"
                  data-on={following}
                  onClick={() => void toggleFollow()}
                  aria-label={following ? '取消追剧' : '追剧'}
                >
                  {following ? '✓' : '+'}
                </button>
              </div>
            </div>
            <button
              type="button"
              className="feedv__fav"
              onClick={() => void toggleFavorite()}
              aria-label={favorited ? '取消收藏' : '收藏'}
            >
              <span className="feedv__fav-icon" data-on={favorited}>
                {favorited ? '★' : '☆'}
              </span>
              <span className="feedv__fav-label">{favorited ? '已收藏' : '收藏'}</span>
            </button>
            <div className="feedv__prog" aria-hidden="true">
              <span className="feedv__prog-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
              <span className="feedv__prog-dot" style={{ left: `${Math.round(progress * 100)}%` }} />
            </div>
          </>
        )}

        {danmakuPrefs.enabled && (
          <DanmakuLayer
            items={shownDanmaku}
            clockMs={Math.round(time * 1000)}
            paused={!playing}
            episodeKey={item.episodeId}
            prefs={danmakuPrefs}
          />
        )}

        {(qualityBusy || autoHd) && ready && (
          <div className="feedv__quality-busy" role="status">
            <span className="feedv__spinner" />
            {autoHd ? '流畅秒开 · 高清准备中' : '正在切换清晰度…'}
          </div>
        )}

        {waiting && (
          <div className="feedv__waiting">
            <div className="feedv__spinner" />
            <p>{job?.message ?? '正在准备这一集…'}</p>
            {job !== null && job.state !== 'failed' && (
              <div className="feedv__bar">
                <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
              </div>
            )}
          </div>
        )}

        {error !== '' && active && (
          <div className="feedv__waiting">
            <p>{error}</p>
            <button
              className="btn"
              onClick={() => {
                setError('');
                setRetry((n) => n + 1);
              }}
            >
              重试
            </button>
          </div>
        )}

      {/* 右侧操作：顺序对齐官方「收藏 / 评论 / 点赞 / 分享」；手机端收藏落在画面上，这里只留后三项 */}
      <div className="feedv__rail">
        <button
          className="feedv__rail-btn feedv__rail-btn--fav"
          onClick={() => void toggleFavorite()}
          title={favorited ? '取消收藏' : '收藏'}
        >
          <span className="feedv__rail-icon" data-on={favorited}>
            {favorited ? '★' : '☆'}
          </span>
          <span>收藏</span>
        </button>
        <button className="feedv__rail-btn" onClick={onComments} title="评论">
          <span className="feedv__rail-icon"><RailCommentIcon /></span>
          <span>评论</span>
          <b className="feedv__rail-num">{fmtCount(item.commentCount)}</b>
        </button>
        <button className="feedv__rail-btn" onClick={() => void toggleLike()} title={liked ? '取消点赞' : '点赞'}>
          <span className="feedv__rail-icon" data-on={liked}>
            {liked ? '♥' : '♡'}
          </span>
          <span>点赞</span>
          <b className="feedv__rail-num">{fmtCount(digg)}</b>
        </button>
        <button className="feedv__rail-btn feedv__rail-btn--share" onClick={() => void share()} title="分享">
          <span className="feedv__rail-icon">↗</span>
          <span>分享</span>
        </button>
        <button className="feedv__rail-btn" onClick={() => void download()} title="下载这一集">
          <IconDownload size={20} />
          <span>下载</span>
        </button>
        <button className="feedv__rail-btn" onClick={onRemove} title="不感兴趣">
          <span className="feedv__rail-icon">⊘</span>
          <span>不感兴趣</span>
        </button>
      </div>

      {mob === null && (
      <div className="feedv__info">
        <div className="feedv__badges">
          <span className="feedv__badge">第 {item.episodeNo} 集</span>
          {item.heatText !== '' && <span className="feedv__badge feedv__badge--ghost">{item.heatText}</span>}
          {item.finished && <span className="feedv__badge feedv__badge--ghost">已完结</span>}
        </div>
        <h2 className="feedv__title">{item.title}</h2>
        {item.tags.length > 0 && (
          <div className="feedv__tags">
            {item.tags.slice(0, 4).map((tag) => (
              <span key={tag} className="feedv__tag">
                {tag}
              </span>
            ))}
          </div>
        )}
        <div className="feedv__m-facts">
          {item.episodeCount > 0 && <span>全 {item.episodeCount} 集</span>}
          {item.finished && <span>已完结</span>}
          {item.heatText !== '' && <span>{item.heatText}</span>}
        </div>
        <p className={`feedv__intro${introOpen ? ' feedv__intro--open' : ''}`}>{item.intro}</p>
        <div className="feedv__m-tools">
          <button className="feedv__m-link" type="button" onClick={() => setIntroOpen((v) => !v)}>
            {introOpen ? '收起' : '展开'}
          </button>
        </div>
        <p className="feedv__note">本地播放 · 数据只留在你的电脑上</p>
        <div className="feedv__info-actions">
          <button className="btn btn--ghost btn--sm" onClick={() => setIntroOpen((v) => !v)}>
            {introOpen ? '收起' : '展开'}
          </button>
          <button className="btn btn--ghost btn--sm" onClick={() => openDetail(item.seriesId)}>
            查看详情
          </button>
        </div>
        </div>
      )}

      {/* 手机端左下三层：弹幕/榜单 → @来源 → 一行简介（展开看全稿） */}
      {mob !== null && (
        <div className="feedv__m-stage">
          <div className="feedv__m-top">
            <button
              type="button"
              className="feedv__dm"
              data-on={danmakuPrefs.enabled}
              onClick={() => patchDanmaku({ enabled: !danmakuPrefs.enabled })}
              aria-label={danmakuPrefs.enabled ? '关闭弹幕' : '打开弹幕'}
            >
              弹
            </button>
            {item.heatText !== '' && (
              <button type="button" className="feedv__rank" onClick={() => mob.go('rank')}>
                <span className="feedv__rank-trophy">🏆</span>
                <span className="feedv__rank-text">{item.heatText}</span>
                <span className="feedv__rank-arrow">›</span>
              </button>
            )}
          </div>
          <p className="feedv__m-author">@红果短剧</p>
          <div className="feedv__m-introrow">
            <p className="feedv__m-intro">{item.intro !== '' ? item.intro : item.title}</p>
            <button type="button" className="feedv__m-more" onClick={() => setIntroOpen(true)}>
              展开
            </button>
          </div>
        </div>
      )}

        <button className="feedv__watch" type="button" onClick={() => openDetail(item.seriesId)}>
          <span className="feedv__watch-play">▶</span>
          <span className="feedv__watch-text">
            {kind} · {item.title}
            {item.episodeCount > 0 ? ` · 全 ${item.episodeCount} 集` : ''}
          </span>
          <span className="feedv__watch-arrow">›</span>
        </button>

        {introOpen && createPortal(
          <div className="feedv__synopsis" role="dialog" aria-modal="true" aria-label="剧情简介">
            <button className="feedv__synopsis-mask" type="button" aria-label="关闭" onClick={() => setIntroOpen(false)} />
            <div className="feedv__synopsis-panel">
              <div className="feedv__synopsis-head">
                <span>剧情简介</span>
                <button className="feedv__synopsis-close" type="button" onClick={() => setIntroOpen(false)}>
                  收起
                </button>
              </div>
              <p>{item.intro}</p>
            </div>
          </div>,
          document.body,
        )}
      </div>
    </section>
  );
}

