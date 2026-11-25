/**
 * 「分享续播」的链接工具。
 *
 * 红果官方分享链接（`.../video-animation-share?...`）的参数含义**和我们最初的假设相反**：
 *
 *   video_id           → 剧集（book / series）id
 *   vid / share_toast_vid → 分集（episode）id
 *
 * 实测一条真实链接：
 *   ?encrypt_did=...&video_id=7687938296130833470&vid=7687958768876784665&share_toast_vid=7687958768876784665
 * 其中 video_id 用 `/api/series/<id>` 能拿到 469 集的剧，vid 是第 3 集。
 *
 * 我们自己生成的链接也按官方这套参数来（`video_id`=剧、`vid`=集），
 * 再额外挂 `no`/`t` 给本软件解析 —— 红果网页会忽略不认识的两个参数。
 *
 * 兼容两种形态：
 *   1. 官方：video_id=剧, vid=集
 *   2. 带 book_id 的老式链接：book_id=剧, video_id=集
 *   3. 只有剧 id（没有集）：调用方自己去剧集列表里挑（优先上次看到的那一集）
 */

export interface SharedRef {
  /** 剧 id */
  seriesId: string;
  /** 集 id；链接里没带就是 ''（调用方自己去剧集列表里查） */
  episodeId: string;
  /** 集号；没带就是 0 */
  no: number;
  /** 起播秒数；0 = 按本地进度续播 */
  startAt: number;
}

const HONGUO_SHARE = 'https://novelquickapp.com/hongguo/ug/pages/video-animation-share';

/** 生成红果原链接（按官方参数命名：video_id=剧、vid=集；另挂 no/t 供本软件解析）。 */
export function hongguoShareLink(seriesId: string, episodeId: string, no: number, at = 0): string {
  const params = new URLSearchParams({
    video_id: seriesId,
    vid: episodeId,
    share_toast_vid: episodeId,
    share_type: '4',
    landing_source: 'share',
  });
  if (no > 0) params.set('no', String(no));
  if (at > 0) params.set('t', at.toFixed(1));
  return `${HONGUO_SHARE}?${params.toString()}`;
}

/** 从 query 里取第一个命中且非空的键 */
function pick(params: URLSearchParams, keys: string[]): string {
  for (const key of keys) {
    const value = params.get(key);
    if (value !== null && value !== '') return value;
  }
  return '';
}

/** 只看数字 ID：红果的 19 位 ID 必须当字符串用 */
function id(raw: string): string {
  const m = /\d{6,25}/.exec(raw);
  return m === null ? '' : m[0];
}

const SERIES_KEYS = ['book_id', 'bookId', 'series_id', 'seriesId', 'book', 'series'];
const EPISODE_KEYS = ['vid', 'share_toast_vid', 'episode_id', 'episodeId', 'episode', 'item_id', 'itemId'];

/**
 * 解析粘贴进来的文本，返回剧/集/位置；认不出返回 null。
 *
 * 支持：红果分享链接、本软件的 `#/play/…` 链接、裸文本 `剧id 集id [集号] [秒]`。
 */
export function parseSharedLink(raw: string): SharedRef | null {
  const text = raw.trim();
  if (text === '') return null;

  // 1) 我们自己的 hash 路由
  const hash = /#\/play\/(\d{6,25})\/(\d{6,25})\/(\d{1,4})(?:\?[^#]*?\bt=([\d.]+))?/.exec(text);
  if (hash !== null) {
    const t = Number.parseFloat(hash[4] ?? '0');
    return {
      seriesId: hash[1] ?? '',
      episodeId: hash[2] ?? '',
      no: Number.parseInt(hash[3] ?? '1', 10),
      startAt: Number.isFinite(t) ? Math.max(0, t) : 0,
    };
  }

  // 2) 红果分享链接
  const query = text.includes('?') ? text.slice(text.indexOf('?') + 1) : '';
  if (query !== '') {
    const params = new URLSearchParams(query.split('#')[0] ?? '');
    const bookId = id(pick(params, SERIES_KEYS));
    const vidId = id(pick(params, EPISODE_KEYS));
    const videoId = id(pick(params, ['video_id', 'videoId', 'video']));

    let seriesId = '';
    let episodeId = '';
    if (bookId !== '') {
      // 老式形态：book_id = 剧，video_id = 分集
      seriesId = bookId;
      episodeId = vidId !== '' ? vidId : videoId;
    } else if (videoId !== '') {
      // 官方形态：video_id = 剧，vid / share_toast_vid = 分集（可以为空 = 整部剧的分享）
      seriesId = videoId;
      episodeId = vidId;
    } else if (vidId !== '') {
      // 只有分集 id、没有剧 id：本软件没法反查（剧号必须由链接给出）
      return null;
    }

    if (seriesId !== '') {
      const noRaw = Number.parseInt(pick(params, ['no', 'episode_no', 'episodeNo', 'index']) || '0', 10);
      const tRaw = Number.parseFloat(pick(params, ['t', 'at', 'from', 'position', 'start']) || '0');
      return {
        seriesId,
        episodeId,
        no: Number.isFinite(noRaw) && noRaw > 0 ? noRaw : 0,
        startAt: Number.isFinite(tRaw) && tRaw > 0 ? tRaw : 0,
      };
    }
  }

  // 3) 裸文本：`剧id 集id [集号] [秒]`
  const parts = text.split(/[\s,，]+/).filter((s) => s !== '');
  if (parts.length >= 2) {
    const seriesId = id(parts[0] ?? '');
    const episodeId = id(parts[1] ?? '');
    if (seriesId !== '' && episodeId !== '') {
      const no = Number.parseInt(parts[2] ?? '0', 10);
      const t = Number.parseFloat(parts[3] ?? '0');
      return {
        seriesId,
        episodeId,
        no: Number.isFinite(no) && no > 0 ? no : 0,
        startAt: Number.isFinite(t) && t > 0 ? t : 0,
      };
    }
  }

  return null;
}
