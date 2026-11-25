/**
 * 弹幕：按播放时间取一段（上游 30 秒一页）。
 *
 * 注意上游的行为：某一页可能没有条目，但 has_more 仍为真——所以"这页空"
 * 不能当成没有弹幕，必须继续翻，否则前 30 秒没弹幕的剧会显得完全没弹幕。
 */
import { getClient, withRetry } from './client.ts';
import { TtlCache } from '../util/cache.ts';

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

/** 同一段 30 秒反复拖动进度会重复请求，缓存 5 分钟。 */
const cache = new TtlCache<DanmakuSlice>(256, 5 * 60_000);

export function danmakuSlice(
  seriesId: string,
  episodeId: string,
  startMs: number,
  cursor: string,
): Promise<DanmakuSlice> {
  const key = `${episodeId}:${startMs}:${cursor}`;
  return cache.wrap(key, async () => {
    const client = await getClient();
    const query: { startMs?: number; cursor?: string } = {};
    if (cursor !== '') query.cursor = cursor;
    else query.startMs = Math.max(0, startMs);

    const res = await withRetry('弹幕', () => client.listDanmaku(seriesId, episodeId, query));
    return {
      items: res.items.map((d) => ({ id: d.id, text: d.text, offsetMs: d.offset_ms, likes: d.likes ?? 0 })),
      startMs: res.start_ms,
      endMs: res.end_ms ?? 0,
      nextCursor: res.cursor ?? '',
      hasMore: res.has_more === true,
      total: res.total ?? 0,
    };
  });
}
