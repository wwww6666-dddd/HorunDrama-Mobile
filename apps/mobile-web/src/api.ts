/** 前端 ↔ 核心的接口层：只认 /api，不直连上游。 */

export interface Drama {
  seriesId: string;
  title: string;
  cover: string;
  intro: string;
  episodeCount: number;
  finished: boolean;
  heatText: string;
  tags: string[];
}

export interface HomeSection {
  tabType: string;
  tabName: string;
  items: Drama[];
}

export interface Paged {
  items: Drama[];
  page: number;
  hasMore: boolean;
}

export interface RankBoard {
  id: string;
  name: string;
}

export interface RankGroup {
  id: string;
  name: string;
  boards: RankBoard[];
}

export type RankEntry =
  | { kind: 'series'; rank: number; score: string; drama: Drama }
  | { kind: 'actor'; rank: number; score: string; userId: string; name: string; avatar: string; intro: string };

export interface RankPage {
  content: string;
  board: string;
  groups: RankGroup[];
  items: RankEntry[];
  hasMore: boolean;
  cursor: string;
}

export interface FilterRow {
  key: string;
  name: string;
  options: Array<{ name: string; value: string }>;
}

export interface SeriesDetail {
  drama: Drama;
  tags: string[];
  episodes: Array<{
    episodeId: string;
    no: number;
    playable: boolean;
    diggCount?: number;
    commentCount?: number;
  }>;
  recommendations: Drama[];
  seasons: Drama[];
}

export type PlayState = 'queued' | 'working' | 'ready' | 'failed';
/** file=本地 mp4；direct=上游 CDN 直连（浏览器直接播） */
export type PlayMode = 'file' | 'direct';

export interface PlayJob {
  jobId: string;
  mode: PlayMode;
  state: PlayState;
  progress: number;
  message: string;
  url: string;
  durationSec: number;
  definition: string;
  /** 可选的清晰度：smooth（360p 直连）/ 480p / 720p / 1080p */
  available: string[];
  /** 后台正在准备的高清任务；ready 后可无缝换源 */
  upgradeJobId: string;
  upgradeQuality: string;
  error: string;
}

export type DownloadStatus = 'queued' | 'working' | 'ready' | 'failed' | 'paused' | 'canceled';

export interface DownloadItem {
  id: string;
  seriesId: string;
  seriesTitle: string;
  cover: string;
  episodeId: string;
  episodeNo: number;
  quality: string;
  status: DownloadStatus;
  progress: number;
  message: string;
  bytes: number;
  totalBytes: number;
  file: string;
  error: string;
  createdAt: number;
  updatedAt: number;
}

export interface DownloadSummary {
  total: number;
  queued: number;
  working: number;
  ready: number;
  failed: number;
  bytes: number;
}

export interface DownloadsPayload {
  items: DownloadItem[];
  summary: DownloadSummary;
  dir: string;
}

export interface NewReleaseItem {
  seriesId: string;
  title: string;
  cover: string;
  intro: string;
  episodeCount: number;
  online: boolean;
  publishAt: string;
  categories: string[];
  heat: string;
  note: string;
}

export interface NewReleasePage {
  date: string;
  dates: string[];
  items: NewReleaseItem[];
  hasMore: boolean;
  cursor: string;
}

export interface ProgressEntry {
  seriesId: string;
  seriesTitle: string;
  cover: string;
  episodeId: string;
  episodeNo: number;
  positionSec: number;
  durationSec: number;
  updatedAt: number;
}

export interface AccountResume {
  seriesId: string;
  episodeId: string;
  episodeNo: number;
  positionSec: number;
  durationSec: number;
  updatedAt: number;
}

export interface FavoriteEntry {
  seriesId: string;
  seriesTitle: string;
  cover: string;
  episodeCount: number;
  updatedAt: number;
}

export interface LikeEntry {
  seriesId: string;
  seriesTitle: string;
  cover: string;
  episodeCount: number;
  updatedAt: number;
}

export interface FollowEntry {
  seriesId: string;
  seriesTitle: string;
  cover: string;
  /** 上次确认过的总集数 */
  episodeCount: number;
  latestCount: number;
  hasNew: boolean;
  followedAt: number;
  updatedAt: number;
}

export interface ReservationEntry {
  seriesId: string;
  seriesTitle: string;
  cover: string;
  episodeCount: number;
  online: boolean;
  updatedAt: number;
}

export interface AccountSyncResult {
  ok: boolean;
  history: number;
  favorites: number;
  follows: number;
  reservations: number;
  message: string;
  at: number;
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  code?: string;
  message?: string;
}

async function call<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' }, signal });
  const body = (await res.json()) as Envelope<T>;
  if (!body.ok || body.data === undefined) {
    throw new Error(body.message ?? `请求失败（${res.status}）`);
  }
  return body.data;
}

/** 写接口：body 一律 JSON；keepalive 让"关页面时上报进度"也能发出去。 */
async function postJson<T>(path: string, payload: unknown, keepalive = false): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
    keepalive,
  });
  const body = (await res.json()) as Envelope<T>;
  if (!body.ok || body.data === undefined) {
    throw new Error(body.message ?? `请求失败（${res.status}）`);
  }
  return body.data;
}

/** 封面走本地代理：上游要 referer、且是 HEIC，浏览器直接加载会被拒。 */
export function coverOf(drama: Drama): string {
  if (drama.cover === '') return '';
  return `/api/img?url=${encodeURIComponent(drama.cover)}`;
}

export const api = {
  home: (signal?: AbortSignal) => call<HomeSection[]>('/api/home', signal),
  feed: (cursor = '', tab: FeedTab = 'recommend', refresh = false, signal?: AbortSignal) =>
    call<FeedPage>(
      `/api/feed?cursor=${encodeURIComponent(cursor)}&tab=${tab}${refresh ? '&refresh=1' : ''}`,
      signal,
    ),
  newReleases: (date = '', cursor = '', signal?: AbortSignal) =>
    call<NewReleasePage>(
      `/api/new-releases?date=${encodeURIComponent(date)}&cursor=${encodeURIComponent(cursor)}`,
      signal,
    ),
  search: (q: string, page = 1, tab = '', signal?: AbortSignal) =>
    call<Paged>(`/api/search?q=${encodeURIComponent(q)}&page=${page}&tab=${encodeURIComponent(tab)}`, signal),
  suggest: (q: string, signal?: AbortSignal) =>
    call<Array<{ text: string; keyword?: string }>>(`/api/suggest?q=${encodeURIComponent(q)}`, signal),
  category: (selections: Record<string, string[]>, page = 1, signal?: AbortSignal) => {
    const s = encodeURIComponent(JSON.stringify(selections));
    return call<Paged>(`/api/category?selections=${s}&page=${page}`, signal);
  },
  filters: (signal?: AbortSignal) => call<{ rows: FilterRow[] }>('/api/filters', signal),
  rank: (content: string, board: string, cursor = '', signal?: AbortSignal) =>
    call<RankPage>(
      `/api/rank?content=${encodeURIComponent(content)}&board=${encodeURIComponent(board)}&cursor=${encodeURIComponent(cursor)}`,
      signal,
    ),
  series: (id: string, signal?: AbortSignal) => call<SeriesDetail>(`/api/series/${encodeURIComponent(id)}`, signal),
  resolveShare: (url: string) =>
    call<{ url: string }>(`/api/share/resolve?url=${encodeURIComponent(url)}`),
  play: (episodeId: string, quality = '', upgrade = false, hevc = false, live = false, wait = false) => {
    const params = new URLSearchParams();
    if (quality !== '') params.set('quality', quality);
    if (upgrade) params.set('upgrade', '1');
    if (hevc) params.set('hevc', '1');
    if (live) params.set('live', '1');
    // wait=1：没有缓存时"等高清文件准备好再播"，不先给 360p 直连/秒开流
    if (wait) params.set('wait', '1');
    const qs = params.toString();
    return call<PlayJob>(
      `/api/play/${encodeURIComponent(episodeId)}${qs === '' ? '' : `?${qs}`}`,
    );
  },
  prepare: (jobId: string) => call<PlayJob>(`/api/prepare/${encodeURIComponent(jobId)}`),
  /** 预加载前后若干集（集数由服务端设置 preloadCount 决定） */
  preload: (episodeIds: string[], quality: string, hevc: boolean) =>
    postJson<{ queued: number; limit: number }>('/api/preload', { episodeIds, quality, hevc }),
  /** 预热下一集的官网直连地址 */
  prewarm: (episodeId: string) =>
    call<{ warming: boolean }>(`/api/prewarm/${encodeURIComponent(episodeId)}`),
  /** 只起高清任务（不动正在播的），上游限流时 503 */
  startUpgrade: (episodeId: string, quality = '720p', hevc = false) =>
    call<PlayJob>(
      `/api/upgrade/${encodeURIComponent(episodeId)}?quality=${encodeURIComponent(quality)}${hevc ? '&hevc=1' : ''}`,
    ),

  // ---- 下载 ----
  downloads: (signal?: AbortSignal) => call<DownloadsPayload>('/api/downloads', signal),
  addDownloads: (input: {
    seriesId: string;
    seriesTitle: string;
    cover: string;
    episodes: Array<{ episodeId: string; no: number }>;
  }) => postJson<{ queued: number; summary: DownloadSummary }>('/api/download', input),
  downloadAction: (action: 'pause' | 'resume' | 'retry' | 'cancel' | 'remove' | 'reveal', id: string) =>
    postJson<{ ok: boolean }>('/api/download/action', { action, id }),
  openDownloadDir: () => postJson<{ ok: boolean }>('/api/download/open-dir', {}),

  /** 正在追的（按更新时间倒序） */
  continueWatching: (limit = 12, signal?: AbortSignal) => call<ProgressEntry[]>(`/api/progress/continue?limit=${limit}`, signal),
  progressFor: (seriesId: string, signal?: AbortSignal) =>
    call<ProgressEntry | null>(`/api/progress?seriesId=${encodeURIComponent(seriesId)}`, signal),
  saveProgress: (
    input: {
      seriesId: string;
      seriesTitle: string;
      cover: string;
      episodeId: string;
      episodeNo: number;
      positionSec: number;
      durationSec: number;
    },
    keepalive = false,
  ) => postJson<{ saved: boolean }>('/api/progress', input, keepalive),
  clearProgress: (seriesId?: string) => postJson<{ removed: number }>('/api/progress/clear', seriesId === undefined ? {} : { seriesId }),

  favorites: (signal?: AbortSignal) => call<FavoriteEntry[]>('/api/favorites', signal),
  favoriteFor: (seriesId: string, signal?: AbortSignal) =>
    call<{ favorite: boolean }>(`/api/favorite/${encodeURIComponent(seriesId)}`, signal),
  toggleFavorite: (input: { seriesId: string; seriesTitle: string; cover: string; episodeCount: number }) =>
    postJson<{ added: boolean }>('/api/favorite', input),

  likes: (signal?: AbortSignal) => call<LikeEntry[]>('/api/likes', signal),
  likeFor: (seriesId: string, signal?: AbortSignal) =>
    call<{ liked: boolean }>(`/api/like/${encodeURIComponent(seriesId)}`, signal),
  toggleLike: (input: {
    seriesId: string;
    seriesTitle: string;
    cover: string;
    episodeCount: number;
    episodeId?: string;
  }) => postJson<{ liked: boolean }>('/api/like', input),
  setReservation: (input: {
    seriesId: string;
    seriesTitle: string;
    cover: string;
    episodeCount: number;
    reserve: boolean;
  }) => postJson<{ reserved: boolean }>('/api/reservation', input),

  follows: (signal?: AbortSignal) => call<FollowEntry[]>('/api/follows', signal),
  followFor: (seriesId: string, signal?: AbortSignal) =>
    call<{ following: boolean }>(`/api/follow/${encodeURIComponent(seriesId)}`, signal),
  toggleFollow: (input: { seriesId: string; seriesTitle: string; cover: string; episodeCount: number }) =>
    postJson<{ following: boolean }>('/api/follow', input),
  reservations: (signal?: AbortSignal) => call<ReservationEntry[]>('/api/reservations', signal),
  accountSync: (force = false) => postJson<AccountSyncResult>('/api/account/sync', { force }),
  accountResume: (seriesId: string, signal?: AbortSignal) =>
    call<AccountResume | null>(`/api/account/progress/${encodeURIComponent(seriesId)}`, signal),

  settings: (signal?: AbortSignal) => call<Settings>('/api/settings', signal),  saveSettings: (patch: Partial<Settings>) => postJson<Settings>('/api/settings', patch),
  cacheStats: (signal?: AbortSignal) => call<CacheStats>('/api/cache', signal),
  clearCache: (target: 'all' | 'media' | 'images') => postJson<{ media: { removed: number }; images: { removed: number } }>('/api/cache/clear', { target }),

  // ---- 账号 ----
  accountStatus: (signal?: AbortSignal) => call<AccountStatus>('/api/account/status', signal),
  accountVerify: () => call<{ ok: boolean; code: number; message: string }>('/api/account/verify'),
  accountSendCode: (mobile: string) =>
    postJson<{ ok: boolean; code: number; message: string; smsCodeKey?: string; retryAfter?: number }>(
      '/api/account/login/send-code',
      { mobile },
    ),
  accountLoginSms: (mobile: string, code: string, smsCodeKey?: string) =>
    postJson<{
      ok: boolean;
      code: number;
      message: string;
      profile?: { userId: string; nickname: string };
      needsNewCode?: boolean;
    }>('/api/account/login/sms', { mobile, code, smsCodeKey }),
  accountContinueSms: (mobile: string, code: string) =>
    postJson<{ ok: boolean; code: number; message: string; profile?: { userId: string; nickname: string } }>(
      '/api/account/login/sms/continue',
      { mobile, code },
    ),
  accountLogout: () => postJson<{ loggedIn: boolean }>('/api/account/logout', {}),
  accountQrStart: () =>
    postJson<{ ok: boolean; message: string; qrcode?: string; token?: string; expireAt?: number; hint?: string }>(
      '/api/account/login/qr/start',
      {},
    ),
  accountQrPoll: (token: string) =>
    call<{ status: string; message: string }>('/api/account/login/qr/poll?token=' + encodeURIComponent(token)),
  /** 弹幕：不传 cursor 时按 startMs 取一段；传 cursor 取下一页 */
  danmaku: (seriesId: string, episodeId: string, startMs: number, cursor = '', signal?: AbortSignal) =>
    call<DanmakuSlice>(
      `/api/danmaku?seriesId=${encodeURIComponent(seriesId)}&episodeId=${encodeURIComponent(episodeId)}&startMs=${startMs}&cursor=${encodeURIComponent(cursor)}`,
      signal,
    ),
  comments: (
    input: {
      seriesId: string;
      episodeId: string;
      cursor?: string;
      count?: number;
      startOffset?: number;
      durationMs?: number;
    },
    signal?: AbortSignal,
  ) =>
    call<CommentPage>(
      `/api/comments?seriesId=${encodeURIComponent(input.seriesId)}&episodeId=${encodeURIComponent(input.episodeId)}&cursor=${encodeURIComponent(input.cursor ?? '')}&count=${input.count ?? 20}&startOffset=${input.startOffset ?? 0}&durationMs=${input.durationMs ?? 0}`,
      signal,
    ),
  sendComment: (input: { seriesId: string; episodeId: string; text: string }) =>
    postJson<{ commentId: string; text: string }>('/api/comment', input),
  replies: (
    input: { seriesId: string; episodeId: string; commentId: string; cursor?: string; count?: number },
    signal?: AbortSignal,
  ) =>
    call<CommentPage>(
      `/api/replies?seriesId=${encodeURIComponent(input.seriesId)}&episodeId=${encodeURIComponent(input.episodeId)}&commentId=${encodeURIComponent(input.commentId)}&cursor=${encodeURIComponent(input.cursor ?? '')}&count=${input.count ?? 10}`,
      signal,
    ),
  sendDanmaku: (input: { seriesId: string; episodeId: string; text: string; offsetMs: number }) =>
    postJson<{ commentId: string; text: string }>('/api/danmaku/send', input),
  deleteComment: (input: { commentId: string; episodeId: string; dataType?: number }) =>
    postJson<{ ok: boolean }>('/api/comment/delete', input),
  likeComment: (input: { commentId: string; liked: boolean }) =>
    postJson<{ liked: boolean }>('/api/comment/like', input),
};

export interface Settings {
  mediaCacheDir: string;
  mediaCacheMB: number;
  downloadDir: string;
  /** auto | smooth | 480p | 720p | 1080p */
  defaultQuality: 'auto' | 'smooth' | '480p' | '720p' | '1080p';
  /** 同时下载几集（1~4） */
  downloadConcurrency: number;
  /** 一集播完自动下一集 */
  autoPlayNext: boolean;
  /** 默认倍速（0.75~2） */
  defaultSpeed: number;
  /** 跳过片头（秒，0=不跳） */
  skipIntroSec: number;
  /** 跳过片尾（秒，0=不跳） */
  skipOutroSec: number;
  /** 追剧页给有新集的剧打标 */
  notifyNewEpisodes: boolean;
  /** 打开追剧页时自动同步账号 */
  autoSyncAccount: boolean;
  /** 画质增强：转码时降噪 + 锐化 */
  enhanceVideo: 'off' | 'standard' | 'strong';
  /** 预加载集数（前后各 N 集，0 = 关闭） */
  preloadCount: number;
}

export interface CacheStats {
  media: { dir: string; count: number; bytes: number };
  images: { count: number; bytes: number; limit: number; dir: string };
  settings: Settings;
}

export interface DanmakuItem {
  id: string;
  text: string;
  offsetMs: number;
  likes: number;
}

export interface DanmakuSlice {
  items: DanmakuItem[];
  startMs: number;
  endMs: number;
  nextCursor: string;
  hasMore: boolean;
  total: number;
}

export interface CommentItem {
  id: string;
  text: string;
  user: { userId: string; name: string; avatar: string };
  likeCount: number;
  liked: boolean;
  replyCount: number;
  createTime: number;
  offsetTime: number;
}

export interface CommentPage {
  items: CommentItem[];
  cursor: string;
  hasMore: boolean;
  total: number;
}

export interface FeedItem extends Drama {
  episodeId: string;
  episodeNo: number;
  diggCount: number;
  commentCount: number;
}

export interface FeedPage {
  items: FeedItem[];
  cursor: string;
  hasMore: boolean;
}

export type FeedTab = 'recommend' | 'follow' | 'live' | 'anime';

export interface Health {
  ok: boolean;
  name: string;
  version: string;
  dataRoot: string;
  node: string;
  uptimeSec: number;
}

/** /api/health 实际被统一包了一层 {ok,data}，这里兼容两种形状。 */
export async function pingCore(): Promise<Health | null> {
  try {
    const res = await fetch('/api/health', { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Health } & Partial<Health>;
    if (json.data !== undefined) return json.data;
    return json as Health;
  } catch {
    return null;
  }
}

export interface AccountStatus {
  loggedIn: boolean;
  userId: string;
  nickname: string;
  avatar: string;
  savedAt: number;
  source: string;
  cookieCount: number;
  hasDevice: boolean;
  deviceId: string;
  signerAvailable: boolean;
}