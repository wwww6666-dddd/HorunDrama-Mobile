/**
 * 推荐流：一屏一剧，上下滑切换。
 *
 * 数据用书城推荐（discover）的游标分页；每页再批量取一次详情，补上第一集，
 * 前端才能直接起播（官方客户端的 feed 条目本身就带 series+episode）。
 *
 * tab：
 * - recommend：书城推荐
 * - live / anime：短剧筛选里的「真人剧 / 漫剧」体裁
 * - follow：本机追更列表（上游关注流没有公开接口）
 */
import { getClient, toDrama, withRetry } from './client.ts';
import { TtlCache } from '../util/cache.ts';
import { listFollows } from '../store/progress.ts';
import type { Drama } from '../types.ts';
import type { SeriesSummary } from 'openhongguo';

export type FeedTab = 'recommend' | 'follow' | 'live' | 'anime';

export interface FeedItem extends Drama {
  /** 第一集（可播优先）；没有分集时为空串 */
  episodeId: string;
  episodeNo: number;
  /** 分集点赞/评论数 */
  diggCount: number;
  commentCount: number;
}

export interface FeedPage {
  items: FeedItem[];
  cursor: string;
  hasMore: boolean;
}

const cache = new TtlCache<FeedPage>(64, 60_000);

async function enrich(items: SeriesSummary[]): Promise<FeedItem[]> {
  const client = await getClient();
  const ids = items.map((item) => item.id).slice(0, 30);
  const details = await withRetry('推荐流详情', () => client.getSeriesBatch(ids)).catch(() => []);
  const firstEpisode = new Map<string, { episodeId: string; no: number; digg: number; comment: number }>();
  for (const detail of details) {
    const ep = detail.episodes.find((e) => e.playable !== false) ?? detail.episodes[0];
    if (ep !== undefined) {
      firstEpisode.set(detail.series.id, {
        episodeId: ep.id,
        no: ep.number,
        digg: ep.digg_count ?? 0,
        comment: ep.comment_count ?? 0,
      });
    }
  }
  const out: FeedItem[] = [];
  for (const summary of items) {
    const first = firstEpisode.get(summary.id);
    if (first === undefined) continue;
    out.push({
      ...toDrama(summary),
      episodeId: first.episodeId,
      episodeNo: first.no,
      diggCount: first.digg,
      commentCount: first.comment,
    });
  }
  return out;
}

export function feedPage(cursor: string, tab: FeedTab = 'recommend', refresh = false): Promise<FeedPage> {
  const key = `feed:${tab}:${cursor}`;
  if (refresh) cache.delete(key);
  return cache.wrap(key, async () => {
    const client = await getClient();

    if (tab === 'follow') {
      if (cursor !== '') return { items: [], cursor: '', hasMore: false };
      const follows = listFollows(24);
      if (follows.length === 0) return { items: [], cursor: '', hasMore: false };
      const ids = follows.map((row) => row.seriesId);
      const details = await withRetry('追更详情', () => client.getSeriesBatch(ids)).catch(() => []);
      return {
        items: await enrich(details.map((detail) => detail.series)),
        cursor: '',
        hasMore: false,
      };
    }

    if (tab === 'live' || tab === 'anime') {
      const res = await withRetry(tab === 'live' ? '真人剧' : '漫剧', () =>
        client.shortFilter({
          selections: { genre: [tab === 'live' ? 'short_play' : 'comic_series'] },
          ...(cursor !== '' ? { cursor } : {}),
        }),
      );
      return {
        items: await enrich(res.items),
        cursor: res.cursor ?? '',
        hasMore: res.has_more === true,
      };
    }

    const res = await withRetry('推荐流', () =>
      client.discover(cursor === '' ? undefined : { cursor }),
    );
    return {
      items: await enrich(res.items),
      cursor: res.cursor ?? '',
      hasMore: res.has_more === true,
    };
  });
}
