import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type Player from 'xgplayer';
import { api, type CommentItem, type CommentPage, type DanmakuItem, type PlayJob, type SeriesDetail } from '../api.ts';
import { CAN_PLAY_HEVC } from '../media-support.ts';
import { goBack, replacePlayHash } from '../nav.ts';
import { playHash, type PlayRoute } from '../routes.ts';
import { useApp } from '../store.ts';
import { DanmakuLayer } from '../ui/DanmakuLayer.tsx';
import { DramaPlayer } from '../ui/DramaPlayer.tsx';
import { useDanmaku } from '../hooks/useDanmaku.ts';
import { readDanmakuPrefs, writeDanmakuPrefs, type DanmakuPrefs } from '../settings/danmaku.ts';
import { IconBack, IconDownload } from '../ui/icons.tsx';

interface PlayPrefs {
  autoPlayNext: boolean;
  defaultSpeed: number;
  skipIntroSec: number;
  skipOutroSec: number;
}

/** 最近一次拿到的剧集列表：接口抖动时"自动下一集"仍然可用 */
const DETAIL_CACHE = new Map<string, SeriesDetail>();

function cacheDetail(detail: SeriesDetail): void {
  DETAIL_CACHE.set(detail.drama.seriesId, detail);
  try {
    localStorage.setItem(
      `horun-detail:${detail.drama.seriesId}`,
      JSON.stringify({
        at: Date.now(),
        seriesId: detail.drama.seriesId,
        episodes: detail.episodes.map((e) => ({ episodeId: e.episodeId, no: e.no })),
      }),
    );
  } catch {
    /* 超配额就算了 */
  }
}

/** 从 localStorage 恢复一份"够用"的剧集列表（只有 id 和集数） */
function cachedEpisodes(seriesId: string): Array<{ episodeId: string; no: number }> {
  const mem = DETAIL_CACHE.get(seriesId);
  if (mem !== undefined) return mem.episodes;
  try {
    const raw = localStorage.getItem(`horun-detail:${seriesId}`);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as { episodes?: Array<{ episodeId: string; no: number }> };
    return Array.isArray(parsed.episodes) ? parsed.episodes : [];
  } catch {
    return [];
  }
}

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

/**
 * 从播放地址反推它是哪一集。
 *
 * 地址有三种：`/api/media/<episodeId>-1080p[-hevc].mp4`、`/api/stream/<episodeId>`、
 * `/api/live/<episodeId>`。切集时旧媒体会被 pause，而那一刻路由已经换成新的一集，
 * 不按地址核对就会把上一集的进度写进新一集的记录里（再打开会"跳到别人的进度"）。
 */
function episodeOfUrl(url: string): string {
  const matched = /\/(\d{6,25})(?:[-/.]|$)/.exec(url);
  return matched === null ? '' : (matched[1] ?? '');
}

/** 播放页：xgplayer 控制条 + 沉浸式外壳（顶栏 / 右侧操作栏 / 底部信息）。 */
const QUALITY_LABEL: Record<string, string> = {
  smooth: '360P',
  '480p': '480P',
  '720p': '720P',
  '1080p': '1080P',
};

/** 手机播放页的线性图标：不用 emoji，避免彩色字形和官方白线稿不一致 */
function MpIcon({
  kind,
  size = 26,
}: {
  kind: 'star' | 'comment' | 'heart' | 'share' | 'more' | 'clock' | 'clear' | 'chev';
  size?: number;
}): JSX.Element {
  const paths: Record<string, JSX.Element> = {
    star: <path d="M12 3.2l2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.9-5.4 2.9 1-6-4.3-4.2 6-.9z" />,
    comment: (
      <>
        <path d="M4 5.5h16v10.5H9.5L4 20z" />
        <circle cx="9" cy="10.5" r="1" />
        <circle cx="12" cy="10.5" r="1" />
        <circle cx="15" cy="10.5" r="1" />
      </>
    ),
    heart: <path d="M12 20s-7-4.4-7-9.3A4 4 0 0 1 12 7a4 4 0 0 1 7 3.7c0 4.9-7 9.3-7 9.3z" />,
    share: (
      <>
        <path d="M12 4v10M9 7l3-3 3 3" />
        <path d="M5 14v5h14v-5" />
      </>
    ),
    more: (
      <>
        <circle cx="12" cy="5" r="1.2" />
        <circle cx="12" cy="12" r="1.2" />
        <circle cx="12" cy="19" r="1.2" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v4.5l3 2" />
      </>
    ),
    clear: <path d="M9 4H4v5M15 4h5v5M4 15v5h5M20 15v5h-5" />,
    chev: <path d="M9 5l7 7-7 7" />,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={kind === 'star' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[kind]}
    </svg>
  );
}

export function Play({ route, mobile = false }: { route: PlayRoute; mobile?: boolean }): JSX.Element {
  const [job, setJob] = useState<PlayJob | null>(null);
  const [detail, setDetail] = useState<SeriesDetail | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [moreOpen, setMoreOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [danmaku, setDanmaku] = useState<DanmakuPrefs>(() => readDanmakuPrefs());
  const [localDanmaku, setLocalDanmaku] = useState<DanmakuItem[]>([]);
  const [danmakuText, setDanmakuText] = useState('');
  const [liked, setLiked] = useState(false);
  const [favorited, setFavorited] = useState(false);
  const [diggCount, setDiggCount] = useState(0);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [comments, setComments] = useState<CommentPage | null>(null);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsError, setCommentsError] = useState('');
  const [replyState, setReplyState] = useState<
    Record<string, { items: CommentItem[]; cursor: string; hasMore: boolean; loading: boolean; open: boolean }>
  >({});
  const [commentText, setCommentText] = useState('');
  const [commentSending, setCommentSending] = useState(false);
  const account = useApp((s) => s.account);
  /** 分享续播弹窗（复制本集链接 / 粘贴别人分享的红果链接） */
  const openShare = useApp((s) => s.openShare);
  const [note, setNote] = useState('');
  const [introOpen, setIntroOpen] = useState(false);
  const [episodesOpen, setEpisodesOpen] = useState(false);
  const [prefs, setPrefs] = useState<PlayPrefs | null>(null);
  const [startAt, setStartAt] = useState(0);
  const [startReady, setStartReady] = useState(false);
  /** 上一集刚播完、下一集还没起来：盖一层加载提示，别让"重播"浮层骗人 */
  const [switching, setSwitching] = useState(false);
  /** 这次过渡是从哪一集发起的（路由变了才算切成功） */
  const switchingFrom = useRef('');
  /**
   * 当前 `job` / 播放地址属于**哪一集**。
   *
   * 切集时 `job` 故意不清空（清了会把播放器卸载 → 画中画被关、全屏退出），
   * 所以"job 是 ready"并不代表"新一集能播"：路由已经换到下一集，job 还是上一集的。
   * 没有这个字段就只能看 `job.state`，于是选集后旧画面会继续播、等待层也不出现，
   * 用户看到的就是"点了选集却没反应，等那一集加载完才突然跳过去"。
   */
  const [jobEpisode, setJobEpisode] = useState('');
  /** 这个 effect 上一次为哪一集起过任务（换集时要立刻把旧画面停掉） */
  const lastEpisode = useRef('');
  /** 「分享续播」的起播点只认一次（换清晰度/重取流时不能把人拽回分享点） */
  const shareSeekUsed = useRef('');
  const [quality, setQuality] = useState<string>(() => localStorage.getItem('horun-quality') ?? '1080p');
  const [rate, setRate] = useState(1);
  /** 后台高清转好了：换成它的地址（位置不变） */
  const [upgrade, setUpgrade] = useState<{ url: string; definition: string } | null>(null);
  const [upgradeJobId, setUpgradeJobId] = useState('');
  const [playingDefinition, setPlayingDefinition] = useState('');
  /** 同一档位再点一次也要重新发起（高清取不到时原地重试） */
  const [qualityNonce, setQualityNonce] = useState(0);

  const playerRef = useRef<Player | null>(null);
  const hideTimer = useRef<number | null>(null);
  const clearedRef = useRef(false);
  const detailRef = useRef<SeriesDetail | null>(null);
  detailRef.current = detail;
  const qualitySeek = useRef<number | null>(null);
  const outroSkipped = useRef(false);
  /** live 秒开流失败过一次就不再重试它，避免来回抖 */
  const liveFallback = useRef(false);
  /** 页面容器：全屏作用在它上面，右侧操作栏/弹幕才能留在全屏里 */
  const pageRef = useRef<HTMLDivElement | null>(null);
  /** 已经给哪一集预热过下一集 */
  const prewarmed = useRef('');

  const flash = useCallback((text: string): void => {
    setNote(text);
    window.setTimeout(() => setNote(''), 2600);
  }, []);

  // 详情
  useEffect(() => {
    let alive = true;
    void api
      .series(route.seriesId)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [route.seriesId]);

  // 播放设置
  useEffect(() => {
    let alive = true;
    void api
      .settings()
      .then((s) => {
        if (!alive) return;
        setPrefs({
          autoPlayNext: s.autoPlayNext,
          defaultSpeed: s.defaultSpeed,
          skipIntroSec: s.skipIntroSec,
          skipOutroSec: s.skipOutroSec,
        });
        setRate(s.defaultSpeed);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // 起播放任务：优先本地缓存（完整时长、能拖进度条）；没有缓存就"等它准备好再播"。
  // 不做"先 360p / 秒开流"的折中 —— 管道流/直连的进度条体验都不如本地 mp4，
  // 而前后各 N 集的预加载会把后续集提前转好，追剧时基本不用等。
  useEffect(() => {
    let cancelled = false;
    // 换集（选集 / 上一集下一集 / 自动连播）：**立刻把上一集停下**。
    // 新一集要等取流 + 转码（关增强 7~20s，开增强 ~80s），这期间如果旧画面还在播，
    // 用户会以为"点了选集没反应"，然后播到一半突然跳集。清空 job 又会卸载播放器
    // （画中画/全屏丢失），所以只暂停、不卸载，等待一律由 `waiting` 那层卡盖住。
    const episodeChanged = lastEpisode.current !== '' && lastEpisode.current !== route.episodeId;
    lastEpisode.current = route.episodeId;
    if (episodeChanged) {
      try {
        playerRef.current?.pause();
      } catch {
        /* 播放器还没起来 / 已销毁：忽略 */
      }
    }
    // 切集时**不清空 job / startReady**：保留上一集画面，等新集就绪后原地换源。
    // 一旦清空，readyUrl 变空会把播放器卸载，浏览器会顺手关掉画中画、退出全屏。
    setTime(0);
    setPlaying(false);
    setStartAt(0);
    setUpgrade(null);
    setUpgradeJobId('');
    setPlayingDefinition('');
    outroSkipped.current = false;
    liveFallback.current = false;

    /** 换 job 时连"这是哪一集"一起记下来（只暂停不卸载，靠它判断旧画面还在不在） */
    const applyJob = (next: PlayJob): void => {
      setJob(next);
      setJobEpisode(route.episodeId);
    };

    // 高清起不来（上游限流/转码失败）时的兜底：退官网 360p 直连，至少能接着看
    const fallbackSmooth = async (): Promise<boolean> => {
      const fallback = await api.play(route.episodeId, 'smooth', false, false, false, false).catch(() => null);
      if (cancelled) return true;
      if (fallback !== null && fallback.state === 'ready' && fallback.url !== '') {
        applyJob(fallback);
        setPlayingDefinition(fallback.definition);
        flash('高清没准备好，先用流畅线路播放（可拖动）');
        return true;
      }
      return false;
    };

    void (async () => {
      try {
        let current = await api.play(
          route.episodeId,
          quality,
          true,
          CAN_PLAY_HEVC && !liveFallback.current,
          false,
          // wait=1：没有缓存时等高清文件转好再播，不先给 360p/秒开流
          true,
        );
        if (cancelled) return;
        applyJob(current);
        setPlayingDefinition(current.definition);
        setUpgradeJobId(current.upgradeJobId);
        while (!cancelled && current.state !== 'ready' && current.state !== 'failed') {
          await new Promise((r) => window.setTimeout(r, 1200));
          if (cancelled) return;
          current = await api.prepare(current.jobId);
          if (cancelled) return;
          applyJob(current);
          setPlayingDefinition(current.definition);
          setUpgradeJobId(current.upgradeJobId);
        }
        if (cancelled) return;
        // 转码失败（上游掐断/坏文件重试等）：自动退流畅线路，别让用户卡在"准备失败"
        if (current.state === 'failed') {
          const ok = await fallbackSmooth();
          if (!ok && !cancelled) flash(`准备失败：${current.error}`);
        }
      } catch (err) {
        if (cancelled) return;
        if (await fallbackSmooth()) return;
        applyJob({
          jobId: '',
          mode: 'file',
          state: 'failed',
          progress: 0,
          message: '准备失败',
          url: '',
          durationSec: 0,
          definition: '',
          available: [],
          upgradeJobId: '',
          upgradeQuality: '',
          error: (err as Error).message,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [route.episodeId, quality, qualityNonce]);

  // 上游不总是肯给高清：正在播 360p 时，先立刻问一次高清任务，之后每 3 分钟再试。
  // 通了就无缝换源（用户不需要手动重试）。
  useEffect(() => {
    if (quality === 'smooth') return;
    if (job?.mode !== 'direct' || job.state !== 'ready') return;
    if (upgradeJobId !== '' || upgrade !== null) return;
    let cancelled = false;
    const ask = async (): Promise<void> => {
      const next = await api.startUpgrade(route.episodeId, quality === '' ? '720p' : quality, CAN_PLAY_HEVC && !liveFallback.current).catch(() => null);
      if (cancelled || next === null || next.state === 'failed') return;
      setUpgradeJobId(next.jobId);
    };
    // 起播后 1.2 秒问一次（不打断播放），之后定时重试
    const first = window.setTimeout(() => void ask(), 1200);
    const timer = window.setInterval(() => void ask(), 180_000);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [job?.mode, job?.state, job?.jobId, upgradeJobId, upgrade, quality, route.episodeId]);

  // 后台高清任务：转好就无缝换源（保留当前进度），失败就继续播流畅版
  useEffect(() => {
    const upgradeId = upgradeJobId;
    if (upgradeId === '') return;
    let cancelled = false;
    void (async () => {
      for (let i = 0; i < 180 && !cancelled; i += 1) {
        await new Promise((r) => window.setTimeout(r, 2000));
        if (cancelled) return;
        const next = await api.prepare(upgradeId).catch(() => null);
        if (cancelled || next === null) return;
        if (next.state === 'ready' && next.url !== '') {
          const at = playerRef.current?.currentTime ?? 0;
          if (at > 1) setStartAt(at);
          setUpgrade({ url: next.url, definition: next.definition });
          setPlayingDefinition(next.definition);
          setUpgradeJobId('');
          return;
        }
        if (next.state === 'failed') {
          // 失败就清掉 id，交给上面的定时器 3 分钟后再试
          setUpgradeJobId('');
          if (quality !== '') flash(`${job?.upgradeQuality !== '' ? job?.upgradeQuality : '高清'} 暂时取不到，继续用 ${job?.definition ?? '流畅'}`);
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [upgradeJobId, job?.definition, job?.upgradeQuality, quality, flash]);

  // 算续播点：切清晰度保留当前位置；分享链接带来的 ?t= 优先；否则本地/账号取更新的，再套跳片头
  useEffect(() => {
    if (job?.state !== 'ready' || job.url === '') return;
    let alive = true;
    void (async () => {
      let at = 0;
      if (route.startAt > 0 && shareSeekUsed.current !== route.episodeId) {
        // 「分享续播」：链接里带了对方看到的那一秒，直接用（只生效一次，
        // 否则换清晰度/重取流会把人拽回分享点）
        shareSeekUsed.current = route.episodeId;
        at = route.startAt;
      } else if (qualitySeek.current !== null) {
        at = qualitySeek.current;
        qualitySeek.current = null;
      } else {
        const [local, account] = await Promise.all([
          api.progressFor(route.seriesId).catch(() => null),
          api.accountResume(route.seriesId).catch(() => null),
        ]);
        const candidates: Array<{ pos: number; dur: number; at: number }> = [];
        if (local !== null && local.episodeId === route.episodeId) {
          candidates.push({ pos: local.positionSec, dur: local.durationSec, at: local.updatedAt });
        }
        if (account !== null && account.episodeId === route.episodeId) {
          candidates.push({ pos: account.positionSec, dur: account.durationSec, at: account.updatedAt });
        }
        const usable = candidates
          .filter((c) => c.pos > 15 && !(c.dur > c.pos + 5 && c.dur > 30 && c.pos > c.dur - 5))
          .sort((a, b) => b.at - a.at);
        at = usable[0]?.pos ?? 0;
        const intro = prefs?.skipIntroSec ?? 0;
        if (at < intro) at = intro;
      }
      if (!alive) return;
      setStartAt(at);
      setStartReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [job?.state, job?.url, route.seriesId, route.episodeId, route.startAt, prefs?.skipIntroSec, job?.durationSec]);

  // 点赞 / 收藏状态
  useEffect(() => {
    let alive = true;
    void api.likeFor(route.seriesId).then((r) => alive && setLiked(r.liked)).catch(() => undefined);
    void api.favoriteFor(route.seriesId).then((r) => alive && setFavorited(r.favorite)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [route.seriesId]);

  const report = useCallback((pos: number, dur: number, keepalive = false): void => {
    const d = detailRef.current;
    if (d === null || pos <= 0) return;
    void api
      .saveProgress({
        seriesId: d.drama.seriesId,
        seriesTitle: d.drama.title,
        cover: d.drama.cover,
        episodeId: route.episodeId,
        episodeNo: route.no,
        positionSec: pos,
        durationSec: dur,
      }, keepalive)
      .catch(() => undefined);
  }, [route.episodeId, route.no]);

  useEffect(() => {
    return () => {
      const p = playerRef.current;
      if (p !== null && p.currentTime > 0) report(p.currentTime, p.duration || 0, true);
    };
  }, [report]);

  const neighbor = useCallback(
    (delta: number): void => {
      const go = (d: SeriesDetail | null): boolean => {
        if (d === null) return false;
        const index = d.episodes.findIndex((e) => e.episodeId === route.episodeId);
        const target = d.episodes[index + delta];
        if (target === undefined) {
          if (delta > 0) flash('已经是最后一集了');
          return true;
        }
        // 换集替换当前历史条目：否则自动连播几集后，返回要一集一集退
        replacePlayHash(playHash(route.seriesId, target.episodeId, target.no));
        return true;
      };
      if (go(detailRef.current)) return;
      // detail 没到位（刚启动 / 接口抖动）：先用缓存里的剧集列表
      const cached = cachedEpisodes(route.seriesId);
      if (cached.length > 0) {
        const fake = { episodes: cached } as unknown as SeriesDetail;
        if (go(fake)) return;
      }
      // 再不行现拉一次
      void api
        .series(route.seriesId)
        .then((d) => {
          cacheDetail(d);
          setDetail(d);
          go(d);
        })
        .catch(() => flash('拿不到剧集列表，请点「选集」手动切'));
    },
    [route.seriesId, route.episodeId, flash],
  );

  // 过渡态：只有"路由真的换到下一集"才退出。
  // 早先按 url 判断是错的 —— 切集瞬间 job.url 还是上一集（ready），会立刻误判成"已就绪"。
  useEffect(() => {
    if (!switching) return;
    if (route.episodeId !== switchingFrom.current) {
      setSwitching(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setSwitching(false);
      flash('下一集没拿到，可以点「选集」手动切');
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [switching, route.episodeId, flash]);

  // 系统媒体控件（画中画窗口、Windows 音量浮层、蓝牙耳机按键）也能切集
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    const showTitle = detail?.drama.title ?? '播放中';
    const artworkUrl = detail?.drama.cover ?? '';
    try {
      session.metadata = new MediaMetadata({
        title: `${showTitle} 第 ${route.no} 集`,
        artist: 'HorunDrama',
        album: showTitle,
        artwork: artworkUrl === '' ? [] : [{ src: artworkUrl, sizes: '512x512', type: 'image/jpeg' }],
      });
    } catch {
      /* 元数据失败不影响播放 */
    }
    const bind = (action: MediaSessionAction, fn: (() => void) | null): void => {
      try {
        session.setActionHandler(action, fn);
      } catch {
        /* 浏览器不支持这个动作 */
      }
    };
    bind('nexttrack', () => neighbor(1));
    bind('previoustrack', () => neighbor(-1));
    bind('play', () => void playerRef.current?.play().catch(() => undefined));
    bind('pause', () => playerRef.current?.pause());
    return () => {
      bind('nexttrack', null);
      bind('previoustrack', null);
      bind('play', null);
      bind('pause', null);
    };
  }, [detail, route.no, neighbor]);

  const switchQuality = (next: string): void => {
    const at = playerRef.current?.currentTime ?? 0;
    qualitySeek.current = at > 1 ? at : null;
    setQuality(next);
    // 再点同一档位也重新取一次（例如高清刚才取不到，想立刻重试）
    setQualityNonce((n) => n + 1);
    if (next === '') localStorage.removeItem('horun-quality');
    else localStorage.setItem('horun-quality', next);
  };

  const toggleLike = async (): Promise<void> => {
    if (detail === null) return;
    try {
      const res = await api.toggleLike({
        seriesId: detail.drama.seriesId,
        seriesTitle: detail.drama.title,
        cover: detail.drama.cover,
        episodeCount: detail.drama.episodeCount,
        episodeId: route.episodeId,
      });
      setLiked(res.liked);
      setDiggCount((n) => Math.max(0, n + (res.liked ? 1 : -1)));
    } catch (err) {
      flash(`点赞失败：${(err as Error).message}`);
    }
  };

  const toggleFavorite = async (): Promise<void> => {
    if (detail === null) return;
    try {
      const res = await api.toggleFavorite({
        seriesId: detail.drama.seriesId,
        seriesTitle: detail.drama.title,
        cover: detail.drama.cover,
        episodeCount: detail.drama.episodeCount,
      });
      setFavorited(res.added);
    } catch (err) {
      flash(`收藏失败：${(err as Error).message}`);
    }
  };

  const downloadCurrent = async (): Promise<void> => {
    if (detail === null) return;
    try {
      const res = await api.addDownloads({
        seriesId: detail.drama.seriesId,
        seriesTitle: detail.drama.title,
        cover: detail.drama.cover,
        episodes: [{ episodeId: route.episodeId, no: route.no }],
      });
      flash(res.queued > 0 ? '已加入下载队列' : '已在下载队列里');
    } catch (err) {
      flash(`下载失败：${(err as Error).message}`);
    }
  };

  /** 弹幕外观偏好：写 localStorage 并同步当前页面（播放器设置面板用）。 */
  const patchDanmaku = (patch: Partial<DanmakuPrefs>): void => {
    setDanmaku(writeDanmakuPrefs(patch));
  };

  /** 快捷开关弹幕（D 键 / 控制条按钮）。 */
  const toggleDanmaku = (): void => {
    patchDanmaku({ enabled: !danmaku.enabled });
  };

  /** 播放设置：本地状态立即生效，同时写回核心 settings.json。 */
  const patchPrefs = (patch: Partial<PlayPrefs>): void => {
    setPrefs((prev) => (prev === null ? prev : { ...prev, ...patch }));
    void api.saveSettings(patch).catch(() => flash('设置保存失败（只在本页生效）'));
  };

  const { items: danmakuItems } = useDanmaku({
    seriesId: route.seriesId,
    episodeId: route.episodeId,
    enabled: danmaku.enabled,
    ready: job?.state === 'ready',
    timeMs: Math.round(time * 1000),
  });

  // 本机弹幕：只存 localStorage，不上传
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`horun-danmaku:${route.episodeId}`);
      setLocalDanmaku(raw === null ? [] : (JSON.parse(raw) as DanmakuItem[]));
    } catch {
      setLocalDanmaku([]);
    }
  }, [route.episodeId]);

  const shownDanmaku = useMemo(
    () => [...danmakuItems, ...localDanmaku],
    [danmakuItems, localDanmaku],
  );

  const loadReplies = async (item: CommentItem, cursor = ''): Promise<void> => {
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
        seriesId: route.seriesId,
        episodeId: route.episodeId,
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
      flash(`回复加载失败：${(err as Error).message}`);
      setReplyState((prev) => ({
        ...prev,
        [item.id]: { items: [], cursor: '', hasMore: false, loading: false, open: false },
      }));
    }
  };

  const toggleReplies = (item: CommentItem): void => {
    const current = replyState[item.id];
    if (current?.open === true) {
      setReplyState((prev) => ({
        ...prev,
        [item.id]: { ...current, open: false },
      }));
      return;
    }
    if (current !== undefined && current.items.length > 0) {
      setReplyState((prev) => ({ ...prev, [item.id]: { ...current, open: true } }));
      return;
    }
    void loadReplies(item, '');
  };

  const likeComment = async (item: CommentItem): Promise<void> => {
    const next = !item.liked;
    setComments((prev) =>
      prev === null
        ? prev
        : {
            ...prev,
            items: prev.items.map((row) =>
              row.id === item.id
                ? { ...row, liked: next, likeCount: Math.max(0, row.likeCount + (next ? 1 : -1)) }
                : row,
            ),
          },
    );
    try {
      await api.likeComment({ commentId: item.id, liked: next });
    } catch (err) {
      setComments((prev) =>
        prev === null
          ? prev
          : {
              ...prev,
              items: prev.items.map((row) =>
                row.id === item.id
                  ? { ...row, liked: item.liked, likeCount: item.likeCount }
                  : row,
              ),
            },
      );
      flash(`点赞失败：${(err as Error).message}`);
    }
  };

  const removeComment = async (item: CommentItem): Promise<void> => {
    try {
      await api.deleteComment({ commentId: item.id, episodeId: route.episodeId });
      setComments((prev) =>
        prev === null
          ? prev
          : { ...prev, items: prev.items.filter((row) => row.id !== item.id), total: Math.max(0, prev.total - 1) },
      );
      flash('评论已删除');
    } catch (err) {
      flash(`删除失败：${(err as Error).message}`);
    }
  };

  const sendDanmaku = async (): Promise<void> => {
    const text = danmakuText.trim();
    if (text === '') return;
    try {
      const res = await api.sendDanmaku({
        seriesId: route.seriesId,
        episodeId: route.episodeId,
        text,
        offsetMs: Math.round(time * 1000),
      });
      const item: DanmakuItem = {
        id: res.commentId !== '' ? res.commentId : `remote-${Date.now()}`,
        text,
        offsetMs: Math.round(time * 1000),
        likes: 0,
      };
      setLocalDanmaku((prev) => [...prev, item]);
      setDanmakuText('');
      flash('弹幕已发送');
    } catch (err) {
      flash(`弹幕发送失败：${(err as Error).message}`);
    }
  };

  const loadComments = async (cursor = ''): Promise<void> => {
    setCommentsLoading(true);
    setCommentsError('');
    try {
      const page = await api.comments({
        seriesId: route.seriesId,
        episodeId: route.episodeId,
        cursor,
        count: 20,
        startOffset: 0,
        durationMs: Math.round((playerRef.current?.duration ?? job?.durationSec ?? 0) * 1000),
      });
      setComments((prev) => {
        if (cursor !== '' && prev !== null) {
          return { ...page, items: [...prev.items, ...page.items] };
        }
        return page;
      });
    } catch (err) {
      setCommentsError((err as Error).message);
    } finally {
      setCommentsLoading(false);
    }
  };

  const openComments = (): void => {
    setCommentsOpen(true);
    if (comments === null) void loadComments('');
  };

  const sendComment = async (): Promise<void> => {
    const text = commentText.trim();
    if (text === '') return;
    setCommentSending(true);
    setCommentsError('');
    try {
      const res = await api.sendComment({
        seriesId: route.seriesId,
        episodeId: route.episodeId,
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
      setComments((prev) =>
        prev === null
          ? { items: [item], cursor: '', hasMore: false, total: 1 }
          : { ...prev, items: [item, ...prev.items], total: prev.total + 1 },
      );
      setCommentText('');
    } catch (err) {
      setCommentsError((err as Error).message);
    } finally {
      setCommentSending(false);
    }
  };

  const currentIndex = useMemo(() => {
    if (detail === null) return -1;
    return detail.episodes.findIndex((e) => e.episodeId === route.episodeId);
  }, [detail, route.episodeId]);

  const episode = detail?.episodes.find((e) => e.episodeId === route.episodeId);

  // 预加载：以当前集为中心，前/后各取若干集（数量由服务端设置 preloadCount 决定）。
  // 由近到远给顺序（先下一集），服务端按设置截断后串行转码。
  // **等当前集 ready 之后再排**：否则当前集的转码会和预加载抢 CPU，
  // "等准备好再播"的第一集就会明显变慢。
  useEffect(() => {
    if (job?.state !== 'ready') return;
    const list = detailRef.current?.episodes ?? [];
    if (list.length === 0 || currentIndex < 0) return;
    const around: string[] = [];
    for (let step = 1; step <= 10; step += 1) {
      const next = list[currentIndex + step];
      if (next !== undefined) around.push(next.episodeId);
      const prev = list[currentIndex - step];
      if (prev !== undefined) around.push(prev.episodeId);
    }
    if (around.length === 0) return;
    void api
      .preload(around, quality === '' ? '1080p' : quality, CAN_PLAY_HEVC && !liveFallback.current)
      .catch(() => undefined);
  }, [currentIndex, route.episodeId, quality, job?.state]);

  useEffect(() => {
    setDiggCount(episode?.diggCount ?? 0);
  }, [episode?.episodeId, episode?.diggCount]);

  const episodeCount = detail?.episodes.length ?? 0;
  const title = detail?.drama.title ?? '播放中';
  // 上一集/上一档已经能播的地址：新集还在准备时先继续用它，
  // 这样播放器不会卸载重建（画中画、全屏状态都保得住）
  const lastPlayableUrl = useRef('');
  /** 上面那个地址属于哪一集 —— 决定它能不能用来"先播着" */
  const playableEpisode = useRef('');
  if (upgrade?.url !== undefined) {
    lastPlayableUrl.current = upgrade.url;
    playableEpisode.current = route.episodeId;
  } else if (job?.state === 'ready' && job.url !== '') {
    lastPlayableUrl.current = job.url;
    playableEpisode.current = jobEpisode;
  }
  const readyUrl = upgrade?.url ?? (job?.state === 'ready' ? job.url : lastPlayableUrl.current);
  /** 播放器里挂着的地址其实还是上一集（新集在取流/转码）—— 选集后最常见的状态 */
  const staleMedia = jobEpisode !== '' && jobEpisode !== route.episodeId;
  /**
   * 当前这一集有没有能播的地址（旧档位也算）。
   *
   * 换集：`jobEpisode` 还是上一集 → 直接没有 → 盖等待卡（旧画面已暂停、压暗）。
   * 换清晰度：同一集、旧档位还在播 → 有 → 不盖卡，旧画面继续播到新档位就绪（1.1.3 的行为）。
   */
  const playableNow = playableEpisode.current === route.episodeId;
  const waiting = upgrade === null && !playableNow;
  /** 旧 job 的 message/progress 跟当前集无关，切集那一下一律当成"取流中" */
  const waitingJob = staleMedia ? null : job;
  const waitingNo = currentIndex >= 0 ? currentIndex + 1 : route.no;

  // 键盘：播放器统一处理空格/←→/↑↓（切集），这里只留播放页自己的 d / Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'd' || e.key === 'D') toggleDanmaku();
      // Esc 第一下只退全屏（goBack 里有判断），第二下才回来源页
      else if (e.key === 'Escape') goBack('#/');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toggleDanmaku]);

  const wakeChrome = (): void => {
    if (clearedRef.current) return;
    setChromeVisible(true);
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setChromeVisible(false), 2600);
  };

  // 清屏后第一下点击只负责把控件叫回来，不直接触发播放/暂停
  const tapChrome = (): void => {
    if (clearedRef.current) {
      clearedRef.current = false;
      setChromeVisible(true);
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setChromeVisible(false), 2600);
      return;
    }
    wakeChrome();
  };

  const onTime = useCallback(
    (t: number, d: number): void => {
      setTime(t);
      if (d > 0) setDuration(d);
      // 播到 25 秒就把下一集的 360p 地址预热好（一集只有一次，成本极低）
      if (t > 25) {
        const d0 = detailRef.current;
        if (d0 !== null && prewarmed.current !== route.episodeId) {
          prewarmed.current = route.episodeId;
          const idx = d0.episodes.findIndex((e) => e.episodeId === route.episodeId);
          const next = d0.episodes[idx + 1];
          if (next !== undefined) {
            // 360p 地址先预热，同时把下一集的高清也在后台转好 ——
            // 这样切下一集是"已缓存"，不用再等转码
            void api.prewarm(next.episodeId).catch(() => undefined);
            void api
              .startUpgrade(next.episodeId, quality === '' ? '1080p' : quality, CAN_PLAY_HEVC && !liveFallback.current)
              .catch(() => undefined);
          }
        }
      }
      const outro = prefs?.skipOutroSec ?? 0;
      if (
        outro > 0 &&
        prefs?.autoPlayNext !== false &&
        !outroSkipped.current &&
        detailRef.current !== null &&
        d > outro + 5 &&
        t >= d - outro
      ) {
        outroSkipped.current = true;
        neighbor(1);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prefs?.skipOutroSec, prefs?.autoPlayNext],
  );

  const rateOptions = [0.75, 1, 1.25, 1.5, 2];

  const cycleRate = (): void => {
    const idx = rateOptions.indexOf(rate);
    const next = rateOptions[(idx + 1) % rateOptions.length] ?? 1;
    setRate(next);
    patchPrefs({ defaultSpeed: next });
  };

  const clearScreen = (event?: { stopPropagation: () => void }): void => {
    event?.stopPropagation();
    clearedRef.current = true;
    setMoreOpen(false);
    setQualityOpen(false);
    setChromeVisible(false);
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  const seekTo = (event: { currentTarget: HTMLDivElement; clientX: number }): void => {
    const total = duration > 0 ? duration : (job?.durationSec ?? 0);
    if (total <= 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    const at = ratio * total;
    playerRef.current?.seek(at);
    setTime(at);
  };

  const qualityList = (job?.available?.length ?? 0) > 0 ? (job?.available ?? []) : ['smooth', '480p', '720p', '1080p'];
  const totalSec = duration > 0 ? duration : (job?.durationSec ?? 0);
  const progressRatio = totalSec > 0 ? Math.min(1, Math.max(0, time / totalSec)) : 0;

  return (
    <div
      className={`play${mobile ? ' play--mobile' : ''}`}
      ref={pageRef}
      data-chrome-hidden={!chromeVisible}
      // 等待新集时也要盖掉 xgplayer 的「重播/进入」浮层（play.css 里按这个属性隐藏）
      data-switching={switching || waiting}
      onMouseMove={wakeChrome}
      onClick={tapChrome}
      onTouchStart={tapChrome}
    >
      {readyUrl !== '' && startReady && (
        <DramaPlayer
          fullscreenHost={() => pageRef.current}
          url={readyUrl}
          startAt={startAt}
          rate={rate}
          onPrev={() => neighbor(-1)}
          onNext={() => neighbor(1)}
          onReady={(p) => {
            playerRef.current = p;
          }}
          onTime={onTime}
          onPlaying={(v) => {
            setPlaying(v);
            if (!v) {
              const p = playerRef.current;
              // 切集时被暂停的是**上一集**的媒体（地址里还是上一集），
              // 这条进度不能记到新一集头上（否则下次打开新集会从上一集的位置开始）
              const src = (p?.media as HTMLVideoElement | null)?.currentSrc ?? '';
              if (p !== null && episodeOfUrl(src) === route.episodeId) report(p.currentTime, p.duration || 0);
            }
          }}
          onEnded={() => {
            setPlaying(false);
            const p = playerRef.current;
            if (p !== null) report(p.duration || p.currentTime, p.duration || 0);
            // 只有设置里明确关了才不切；prefs 还没加载完（null）时按默认"开"处理，
            // 否则启动稍慢一点就会出现"播完了却停在重播"。
            if (prefs?.autoPlayNext === false) return;
            switchingFrom.current = route.episodeId;
            setSwitching(true);
            neighbor(1);
          }}
          onError={(msg) => {
            // 秒开流（live）解不开时自动退回安全路径（官网 360p + 转码升清），
            // 避免用户卡在错误提示上
            if (!liveFallback.current && readyUrl.includes('/api/live/')) {
              liveFallback.current = true;
              flash('秒开流不可用，正在切换普通线路…');
              setQualityNonce((n) => n + 1);
              return;
            }
            flash(`播放失败：${msg}`);
          }}
          extras={{
            episodeCount,
            qualities: job?.available ?? [],
            quality,
            definition: playingDefinition,
            rate,
            onRate: (value) => {
              setRate(value);
              patchPrefs({ defaultSpeed: value });
            },
            autoPlayNext: prefs?.autoPlayNext !== false,
            onToggleAutoNext: () => patchPrefs({ autoPlayNext: prefs?.autoPlayNext === false }),
            skipIntroSec: prefs?.skipIntroSec ?? 0,
            skipOutroSec: prefs?.skipOutroSec ?? 0,
            onSkipIntro: (value) => patchPrefs({ skipIntroSec: value }),
            onSkipOutro: (value) => patchPrefs({ skipOutroSec: value }),
            danmakuEnabled: danmaku.enabled,
            danmakuPrefs: danmaku,
            onDanmakuPrefs: patchDanmaku,
            danmakuText,
            onEpisodes: () => setEpisodesOpen(true),
            onQuality: switchQuality,
            onPrev: currentIndex > 0 ? () => neighbor(-1) : undefined,
            onNext: currentIndex >= 0 && currentIndex < episodeCount - 1 ? () => neighbor(1) : undefined,
            onToggleDanmaku: toggleDanmaku,
            onDanmakuText: setDanmakuText,
            onSendDanmaku: sendDanmaku,
          }}
        />
      )}

      {danmaku.enabled && (
        <DanmakuLayer
          items={shownDanmaku}
          clockMs={Math.round(time * 1000)}
          paused={!playing}
          episodeKey={route.episodeId}
          prefs={danmaku}
        />
      )}

      {/* 无边框窗口的拖动条：播放页没有顶栏，不给一条能拖的区域就挪不动窗口 */}
      {!mobile && (
        <>
          <div className="play__dragbar" title="按住拖动窗口" />

      <header className="play__top" data-hidden={!chromeVisible}>
        <button className="btn btn--ghost btn--icon" title="返回上一页" onClick={() => goBack('#/')}>
          <IconBack size={18} />
        </button>
        <div className="play__top-title">
          <strong>{title}</strong>
          <span className="play__ep">
            第 {currentIndex >= 0 ? currentIndex + 1 : route.no} 集{episodeCount > 0 ? ` / ${episodeCount}` : ''}
          </span>
        </div>
      </header>

      <div className="play__rail" data-hidden={!chromeVisible}>
        <button className="play__rail-btn" onClick={() => void toggleLike()} title={liked ? '取消点赞' : '点赞'}>
          <span className="play__rail-icon" data-on={liked}>
            {liked ? '♥' : '♡'}
          </span>
          <em>点赞</em>
          <b className="play__rail-num">{fmtCount(diggCount)}</b>
        </button>
        <button className="play__rail-btn" onClick={openComments} title="评论">
          <span className="play__rail-icon">💬</span>
          <em>评论</em>
          <b className="play__rail-num">{fmtCount(episode?.commentCount ?? 0)}</b>
        </button>
        <button
          className="play__rail-btn"
          onClick={() => void toggleFavorite()}
          title={favorited ? '取消收藏' : '收藏'}
        >
          <span className="play__rail-icon" data-on={favorited}>
            {favorited ? '★' : '☆'}
          </span>
          <em>收藏</em>
        </button>
        <button className="play__rail-btn" onClick={openShare} title="分享续播">
          <span className="play__rail-icon">↗</span>
          <em>分享</em>
        </button>
        <button className="play__rail-btn" onClick={() => void downloadCurrent()} title="下载本集">
          <IconDownload size={20} />
          <em>下载</em>
        </button>
      </div>

      <div className="play__meta" data-hidden={!chromeVisible}>
        <div className="play__meta-badges">
          <span className="play__badge">第 {route.no} 集</span>
          {detail?.drama.heatText !== undefined && detail.drama.heatText !== '' && (
            <span className="play__badge play__badge--ghost">{detail.drama.heatText}</span>
          )}
        </div>
        <h1 className="play__meta-title">{title}</h1>
        {(detail?.drama.tags.length ?? 0) > 0 && (
          <div className="play__meta-tags">
            {detail?.drama.tags.slice(0, 4).map((tag) => (
              <span key={tag} className="play__tag">
                {tag}
              </span>
            ))}
          </div>
        )}
        {detail !== null && detail.drama.intro !== '' && (
          <>
            <p className={`play__meta-intro${introOpen ? ' play__meta-intro--open' : ''}`}>{detail.drama.intro}</p>
            <button className="play__meta-more" onClick={() => setIntroOpen((v) => !v)}>
              {introOpen ? '收起' : '展开'}
            </button>
          </>
        )}
      </div>
        </>
      )}

      {mobile && (
        <>
          <header className="mp-top" data-hidden={!chromeVisible}>
            <button type="button" className="mp-back" aria-label="返回" onClick={() => goBack('#/')}>
              <IconBack size={22} />
            </button>
            <span className="mp-epname">第{currentIndex >= 0 ? currentIndex + 1 : route.no}集</span>
            <button
              type="button"
              className="mp-more-btn"
              aria-label="更多"
              onClick={() => {
                setQualityOpen(false);
                setMoreOpen((v) => !v);
              }}
            >
              <MpIcon kind="more" size={24} />
            </button>
          </header>

          {moreOpen && (
            <div className="mp-menu">
              <button type="button" onClick={() => { setMoreOpen(false); void downloadCurrent(); }}>
                下载本集
              </button>
              <button type="button" onClick={() => { setMoreOpen(false); openShare(); }}>
                分享续播
              </button>
              <button type="button" onClick={() => setMoreOpen(false)}>
                取消
              </button>
            </div>
          )}

          <div className="mp-rail" data-hidden={!chromeVisible}>
            <button type="button" className="mp-rail-btn" onClick={() => void toggleFavorite()} aria-label={favorited ? '取消收藏' : '收藏'}>
              <span className="mp-rail-icon mp-rail-star" data-on={favorited}>
                <MpIcon kind="star" size={30} />
              </span>
              <b>{favorited ? '已收藏' : '收藏'}</b>
            </button>
            <button type="button" className="mp-rail-btn" onClick={openComments} aria-label="评论">
              <span className="mp-rail-icon">
                <MpIcon kind="comment" size={30} />
              </span>
              <b>{fmtCount(episode?.commentCount ?? 0) || '评论'}</b>
            </button>
            <button type="button" className="mp-rail-btn" onClick={() => void toggleLike()} aria-label={liked ? '取消点赞' : '点赞'}>
              <span className="mp-rail-icon mp-rail-heart" data-on={liked}>
                <MpIcon kind="heart" size={30} />
              </span>
              <b>{fmtCount(diggCount) || '点赞'}</b>
            </button>
            <button type="button" className="mp-rail-btn mp-rail-share" onClick={openShare} aria-label="分享">
              <span className="mp-rail-icon">
                <MpIcon kind="share" size={30} />
              </span>
              <b>分享</b>
            </button>
          </div>

          <div className="mp-info" data-hidden={!chromeVisible} data-open={introOpen}>
            <div className="mp-info-badges">
              <button type="button" className="mp-danmaku" data-off={!danmaku.enabled} onClick={toggleDanmaku} aria-label="弹幕开关">
                弹
              </button>
              {detail !== null && detail.drama.heatText !== '' && (
                <span className="mp-hot">🏆 热搜榜 · {detail.drama.heatText}</span>
              )}
            </div>
            <h1 className="mp-title">{title}</h1>
            <div className="mp-sub">
              <span>第{route.no}集｜{detail?.drama.intro ?? ''}</span>
              {detail !== null && detail.drama.intro !== '' && (
                <button type="button" onClick={() => setIntroOpen((v) => !v)}>
                  {introOpen ? '收起' : '展开'}
                </button>
              )}
            </div>
            {introOpen && <p className="mp-intro">{detail?.drama.intro ?? ''}</p>}
            <p className="mp-claim">ⓘ 作者声明：内容由AI生成</p>
          </div>

          <div className="mp-bottom" data-hidden={!chromeVisible}>
            <div className="mp-progress" onClick={seekTo} role="presentation">
              <span style={{ width: `${Math.round(progressRatio * 100)}%` }} />
              <i style={{ left: `${Math.round(progressRatio * 100)}%` }} />
            </div>
            <div className="mp-controls">
              <button
                type="button"
                className="mp-ctl mp-ctl--episodes"
                onClick={() => {
                  setMoreOpen(false);
                  setQualityOpen(false);
                  setEpisodesOpen(true);
                }}
              >
                <span>选集</span>
                <b>⋯</b>
                <MpIcon kind="chev" size={16} />
              </button>
              <button
                type="button"
                className="mp-ctl"
                onClick={() => {
                  setMoreOpen(false);
                  setQualityOpen((v) => !v);
                }}
              >
                <span className="mp-hd">HD</span>
                <span>清晰度</span>
              </button>
              <button type="button" className="mp-ctl" onClick={cycleRate}>
                <MpIcon kind="clock" size={18} />
                <span>{rate}x</span>
              </button>
              <button type="button" className="mp-ctl" onClick={clearScreen}>
                <MpIcon kind="clear" size={18} />
                <span>清屏</span>
              </button>
            </div>

            {qualityOpen && (
              <div className="mp-quality">
                {qualityList.map((item) => (
                  <button
                    type="button"
                    key={item}
                    data-active={item === quality}
                    onClick={() => {
                      setQualityOpen(false);
                      switchQuality(item);
                    }}
                  >
                    {QUALITY_LABEL[item] ?? item}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {waiting && (
        // data-over：下面还挂着上一集的画面（播放器不卸载）→ 压暗 + 延迟淡入，
        // 命中缓存那种"秒切"就不会闪一下卡片；data-failed：失败态可穿透点击（还能选集/重试）
        <div className="play__waiting" data-over={readyUrl !== ''} data-failed={waitingJob?.state === 'failed'}>
          <div className="play__waiting-card glass">
            <p className="play__waiting-title">
              {waitingJob?.state === 'failed' ? '准备失败' : `正在准备第 ${waitingNo} 集`}
            </p>
            <p className="play__waiting-sub">
              {waitingJob?.state === 'failed' ? waitingJob.error : (waitingJob?.message ?? '取流中…')}
            </p>
            {waitingJob?.state !== 'failed' && (
              <div className="play__progress">
                <span style={{ width: `${Math.round((waitingJob?.progress ?? 0) * 100)}%` }} />
              </div>
            )}
            {waitingJob?.state !== 'failed' && (
              <p className="play__waiting-hint">准备好后播本地文件：时长准确、进度条能拖；看剧时前后几集会提前转好</p>
            )}
          </div>
        </div>
      )}

      {/* 只留给"点了下一集但路由没换成"的兜底（6s 后提示手动选集） */}
      {switching && !waiting && (
        <div className="play__switching" role="status">
          <span className="play__spinner" />
          <p>正在加载下一集…</p>
        </div>
      )}

      {note !== '' && <div className="play__toast">{note}</div>}

      {commentsOpen && (
        <div className="play__comments-mask" role="presentation" onClick={() => setCommentsOpen(false)}>
          <aside className="play__comments" role="dialog" aria-label="评论" onClick={(e) => e.stopPropagation()}>
            <header className="play__comments-head">
              <strong>评论</strong>
              <span>{fmtCount(episode?.commentCount ?? 0) || '0'} 条</span>
              <button className="btn btn--ghost btn--icon" onClick={() => setCommentsOpen(false)} aria-label="关闭">
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
              {commentsLoading && comments === null && <p className="play__comments-hint">正在加载评论…</p>}
              {commentsError !== '' && <p className="play__comments-hint">加载失败：{commentsError}</p>}
              {comments?.items.map((item) => {
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
              {comments !== null && comments.items.length === 0 && commentsLoading === false && (
                <p className="play__comments-hint">还没有评论</p>
              )}
              {comments?.hasMore === true && (
                <button
                  className="btn btn--ghost play__comments-more"
                  disabled={commentsLoading}
                  onClick={() => void loadComments(comments.cursor)}
                >
                  {commentsLoading ? '加载中…' : '加载更多'}
                </button>
              )}
            </div>
          </aside>
        </div>
      )}

      {episodesOpen && (
        <div className="play__sheet-mask" role="presentation" onClick={() => setEpisodesOpen(false)}>
          <section className="play__sheet" role="dialog" aria-label="选集" onClick={(e) => e.stopPropagation()}>
            <header className="play__sheet-head">
              <strong>选集</strong>
              <span>{episodeCount > 0 ? `全 ${episodeCount} 集` : ''}</span>
              <button className="btn btn--ghost btn--icon" onClick={() => setEpisodesOpen(false)} aria-label="关闭">
                ✕
              </button>
            </header>
            <div className="play__sheet-grid">
              {detail?.episodes.map((ep) => (
                <button
                  key={ep.episodeId}
                  className="play__sheet-ep"
                  data-active={ep.episodeId === route.episodeId}
                  disabled={!ep.playable}
                  onClick={() => {
                    setEpisodesOpen(false);
                    replacePlayHash(playHash(route.seriesId, ep.episodeId, ep.no));
                  }}
                >
                  {ep.no}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}