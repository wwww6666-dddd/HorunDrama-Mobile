/**
 * 目录类能力：首页、搜索、榜单、筛选、分类。
 * 只做"上游 → 我们的形状"，不做缓存策略之外的事。
 */
import { getClient, heatLabel, normalizeCover, toDrama, withRetry } from './client.ts';
import { createLogger } from '../util/log.ts';
import { CursorPager, TtlCache } from '../util/cache.ts';
import type { Drama, FilterRow, HomeSection, Paged, RankEntry, RankGroup, RankPage } from '../types.ts';

const log = createLogger('catalog');

/** 阶段 0：首页缓存 180s，和推荐流对齐（限流期靠缓存顶住首屏，D-32）。 */
const homeCache = new TtlCache<HomeSection[]>(4, 180_000);
const detailCache = new TtlCache<SeriesDetail>(64, 120_000);
const pager = new CursorPager<Drama>();

// ---------------------------------------------------------------- 首页

export function home(): Promise<HomeSection[]> {
  return homeCache.wrap('home', async () => {
    const client = await getClient();
    const sections: HomeSection[] = [];

    // 冷启动时一次目录请求要 2s 左右，串行就是 8s+ 首屏骨架（实测 8.9s）。
    // 「上新日历」和「书城推荐」互不依赖，并行发；只有第 2 页必须等 cursor。
    const [discoveredSettled, freshSettled] = await Promise.allSettled([
      withRetry('书城推荐', () => client.discover()),
      withRetry('上新日历', () => client.newReleases()),
    ]);

    if (discoveredSettled.status === 'rejected') throw discoveredSettled.reason;
    const discovered = discoveredSettled.value;
    if (discovered.items.length > 0) {
      sections.push({
        tabType: 'recommend',
        tabName: '为你推荐',
        items: discovered.items.map(toDrama),
      });
    }

    if (discovered.has_more === true && discovered.cursor !== undefined && discovered.cursor !== '') {
      const cursor = discovered.cursor;
      // 第 2 页不进首屏关键路径：一次目录请求要 2.5s 左右，为了多 6 部剧把首屏
      // 从 4s 拖到 8s 不划算。这里后台补进缓存数组，下一次进剧场就能看到。
      void withRetry('书城推荐(第2页)', () => client.discover({ cursor }))
        .then((more) => {
          if (more.items.length === 0) return;
          const items = more.items.map(toDrama);
          sections.push({ tabType: 'more', tabName: '继续发现', items });
          void fillDirStats(items);
        })
        .catch(() => undefined);
    }

    if (freshSettled.status === 'fulfilled') {
      const fresh = freshSettled.value;
      if (fresh.items.length > 0) {
        sections.push({
          tabType: 'new',
          tabName: '今日上新',
          items: fresh.items.map((n) =>
            toDrama({
              id: n.series_id,
              title: n.title,
              description: n.description,
              cover_url: n.cover_url,
              episode_count: n.episode_count,
            }),
          ),
        });
      }
    } else {
      log.warn(`上新日历失败: ${(freshSettled.reason as Error).message}`);
    }

    // 补详情最多等 1.2s：冷启动时批量详情要好几秒，首屏不能陪它等。
    // 超时后这个 Promise 还在跑，补到的字段会写回同一批对象（缓存里也一起生效），
    // 下一次进剧场（命中 180s 缓存）就有集数和热度了。
    await Promise.race([
      fillDirStats(sections.flatMap((s) => s.items)),
      new Promise((resolve) => setTimeout(resolve, 1200)),
    ]);
    return sections;
  });
}

/**
 * 目录摘要缺字段：discover / newReleases 只给 id+标题+封面，集数、完结状态、
 * 热度全是空（D-40：剧场卡片只能显示「短剧」，看不出多少集）。
 * 批量详情补一次；失败就保持原样 —— 目录页不能因为"补装饰"整个报错。
 */
async function fillDirStats(items: Drama[]): Promise<void> {
  const need = items.filter((d) => d.episodeCount <= 0 || d.heatText === '');
  const ids = [...new Set(need.map((d) => d.seriesId))].slice(0, 18);
  if (ids.length === 0) return;
  try {
    const client = await getClient();
    const details = await withRetry('目录补详情', () => client.getSeriesBatch(ids));
    const map = new Map(details.map((d) => [d.series.id, d.series]));
    for (const item of need) {
      const s = map.get(item.seriesId);
      if (s === undefined) continue;
      if (item.episodeCount <= 0) item.episodeCount = s.episode_count ?? 0;
      if (item.heatText === '') item.heatText = heatLabel(s);
      if (s.status === 1) item.finished = true;
      if (item.tags.length === 0 && s.category !== undefined && s.category !== '') {
        item.tags = [s.category];
      }
    }
  } catch (err) {
    log.warn(`目录补详情失败（保持原样）: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------- 搜索

const suggestCache = new TtlCache<Array<{ text: string; keyword?: string }>>(64, 60_000);

export function suggestions(prefix: string): Promise<Array<{ text: string; keyword?: string }>> {
  const q = prefix.trim();
  if (q === '') return Promise.resolve([]);
  return suggestCache.wrap(q, async () => {
    const client = await getClient();
    const rows = await withRetry('搜索联想', () => client.suggest(q));
    return rows
      .map((row) => ({ text: row.text, keyword: row.keyword }))
      .filter((row) => row.text !== '')
      .slice(0, 10);
  });
}

export function search(keyword: string, page: number, tab = ''): Promise<Paged<Drama>> {
  const kw = keyword.trim();
  if (kw === '') return Promise.resolve({ items: [], page: 1, hasMore: false });
  return pager.page(`search:${tab}:${kw}`, Math.max(1, page), async (cursor) => {
    const client = await getClient();
    const options: { cursor?: string; filters?: string[] } = {};
    if (cursor !== undefined) options.cursor = cursor;
    if (tab !== '') options.filters = [tab];
    const res = await withRetry(`搜索「${kw}」`, () => client.search(kw, options));
    return { items: res.items.map(toDrama), cursor: res.cursor, hasMore: res.has_more === true };
  });
}

// ---------------------------------------------------------------- 分类（筛选结果）

export function category(selections: Record<string, string[]>, page: number): Promise<Paged<Drama>> {
  const key = `filter:${JSON.stringify(Object.entries(selections).sort())}`;
  return pager.page(key, Math.max(1, page), async (cursor) => {
    const client = await getClient();
    const query: { selections?: Record<string, string[]>; cursor?: string } = { selections };
    if (cursor !== undefined) query.cursor = cursor;
    const res = await withRetry('筛选列表', () => client.shortFilter(query));
    return { items: res.items.map(toDrama), cursor: res.cursor, hasMore: res.has_more === true };
  });
}

/** 筛选面板：体裁/主题/角色/年代/排序/受众/上新时间（外加连载状态）。 */
export async function filterRows(genre?: string): Promise<FilterRow[]> {
  const client = await getClient();
  // SDK 直接返回 FilterRow[]（不是 { rows }）
  const rows = await withRetry('筛选面板', () => client.shortFilterPanel(genre));
  return rows
    .map((row) => ({
      key: row.key,
      name: row.name,
      options: (row.options ?? []).map((o) => ({ name: o.name, value: o.value })),
    }))
    .filter((r) => r.key !== '' && r.options.length > 0);
}

// ---------------------------------------------------------------- 封面补取

/**
 * 搜索结果不带 cover_url（实测：只有 id/title/description/episode_count），
 * 但卡片不能因此空着。按需取详情补封面并缓存——前端滚动加载天然限制了并发。
 */
const coverCache = new TtlCache<string>(256, 10 * 60_000);

export function coverForSeries(seriesId: string): Promise<string> {
  return coverCache.wrap(seriesId, async () => {
    const client = await getClient();
    const series = await withRetry('封面补取', () => client.getSeries(seriesId));
    return normalizeCover(series.cover_url ?? '');
  });
}

// ---------------------------------------------------------------- 详情

/** 分集可能很多（实测 795 集），必须按游标翻完再排序。 */
const MAX_EPISODE_PAGES = 60;

export interface SeriesDetail {
  drama: Drama;
  tags: string[];
  episodes: Array<{
    episodeId: string;
    no: number;
    playable: boolean;
    /** 分集点赞/评论数（上游给的，用于播放页操作栏计数） */
    diggCount?: number;
    commentCount?: number;
  }>;
  recommendations: Drama[];
  seasons: Drama[];
}

async function loadSeries(seriesId: string): Promise<SeriesDetail> {
  const client = await getClient();
  const s = await withRetry('剧集详情', () => client.getSeries(seriesId));
  const base = toDrama(s);
  const extra = s as typeof s & { category?: string; rows?: Array<{ text: string }> };

  const tags = [extra.category, ...(extra.rows ?? []).map((r) => r.text)]
    .filter((t): t is string => typeof t === 'string' && t !== '')
    .slice(0, 6);

  // 推荐/多季和分集一起拉，别串在分集翻页后面
  const recommendationsPromise = withRetry('相关推荐', () => client.seriesRecommend(seriesId))
    .then((rec) => rec.items.filter((x) => x.id !== seriesId).slice(0, 12).map(toDrama))
    .catch(() => []);

  const episodes: SeriesDetail['episodes'] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < MAX_EPISODE_PAGES; guard += 1) {
    const page = await client.listEpisodes(seriesId, cursor === undefined ? undefined : { cursor });
    for (const ep of page.items) {
      episodes.push({
        episodeId: ep.id,
        no: ep.number,
        playable: ep.playable !== false,
        diggCount: ep.digg_count ?? 0,
        commentCount: ep.comment_count ?? 0,
      });
    }
    if (page.has_more !== true || page.cursor === undefined || page.cursor === '') break;
    cursor = page.cursor;
  }
  episodes.sort((a, b) => a.no - b.no);

  const recommendations = await recommendationsPromise;

  const seasons =
    s.is_multi_season === true
      ? await withRetry('多季', () => client.seasons(seriesId))
          .then((album) =>
            (album.seasons ?? [])
              .filter((x) => x.series_id !== seriesId)
              .slice(0, 12)
              .map((x) => {
                const raw = x.title ?? '';
                // 上游标题大多已带"第N季"，别重复拼
                const hasSuffix = /第[一二三四五六七八九十\d]+季/.test(raw);
                const title = hasSuffix || x.index === undefined || x.index <= 0 ? raw : `${raw} 第${x.index}季`;
                return toDrama({
                  id: x.series_id ?? '',
                  title,
                  cover_url: x.cover_url ?? '',
                  episode_count: x.episode_count ?? 0,
                });
              })
              .filter((d) => d.seriesId !== ''),
          )
          .catch(() => [])
      : [];

  return { drama: { ...base, tags }, tags, episodes, recommendations, seasons };
}

export function series(seriesId: string): Promise<SeriesDetail> {
  return detailCache.wrap(seriesId, () => loadSeries(seriesId));
}

// ---------------------------------------------------------------- 榜单

const rankCache = new TtlCache<RankPage>(48, 120_000);

export function rankPage(content: string, board: string, cursor = ''): Promise<RankPage> {
  return rankCache.wrap(`${content}:${board}:${cursor}`, async () => {
    const client = await getClient();
    const query: { content?: string; board?: string; cursor?: string } = {};
    if (content !== '') query.content = content;
    if (board !== '') query.board = board;
    if (cursor !== '') query.cursor = cursor;
    const res = await withRetry('榜单', () => client.shortRank(query));

    const groups: RankGroup[] = (res.contents ?? []).map((g) => ({
      id: g.id,
      name: g.name,
      boards: (g.boards ?? []).map((b) => ({ id: b.id, name: b.name })),
    }));

    const items: RankEntry[] = res.items.map((it) => {
      const row = it as typeof it & { actor_id?: string; user_id?: string; avatar_url?: string; intro?: string };
      const actorName = row.actor ?? '';
      if (actorName !== '' && (row.user_id ?? '') !== '') {
        return {
          kind: 'actor',
          rank: row.position ?? 0,
          score: it.score ?? '',
          userId: row.user_id ?? '',
          name: actorName,
          avatar: normalizeCover(row.avatar_url ?? ''),
          intro: row.intro ?? '',
        };
      }
      return {
        kind: 'series',
        rank: it.position ?? it.rank ?? 0,
        score: it.score ?? '',
        drama: toDrama({
          id: it.series_id ?? '',
          title: it.title ?? '',
          cover_url: it.cover_url ?? '',
          episode_count: it.episode_count ?? 0,
        }),
      };
    });

    return {
      content: res.content,
      board: res.board,
      groups,
      items,
      hasMore: res.has_more === true,
      cursor: res.cursor ?? '',
    };
  });
}

// ---------------------------------------------------------------- 批量集数（追更用）

/** 一次取多部剧的最新总集数；追更列表用它判断有没有新集。 */
export async function seriesCounts(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const client = await getClient();
  try {
    const details = await withRetry('批量集数', () => client.getSeriesBatch(ids.slice(0, 30)));
    for (const detail of details) {
      out.set(detail.series.id, detail.series.episode_count ?? detail.episodes.length);
    }
  } catch (err) {
    log.warn(`批量取集数失败: ${(err as Error).message}`);
  }
  return out;
}
