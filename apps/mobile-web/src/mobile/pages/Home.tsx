/**
 * 剧场页：对齐官方新版「剧场/找剧」。
 *
 * 结构（从上到下）：
 *   搜索框 → 12 个频道 → 四胶囊（筛选/排行榜/新剧/预约）
 *   → 响应式瀑布（手机 2 列、平板 3 列，右列顶部放「继续观看」卡）
 *
 * 官方平板是 3 列、手机是 2 列；用户滑到底部时自动续页，不再只给一屏。
 * 主题：官方剧场浅色；切到深色时整页跟着变深，不再写死白底。
 */
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Drama, type FeedTab, type HomeSection, type ProgressEntry } from '../../api.ts';
import { useAsync } from '../../hooks/useAsync.ts';
import { useNav } from '../nav.tsx';
import { readSnapshot, writeSnapshot } from '../snapshot.ts';
import { Icon } from '../ui.tsx';

const CATS = ['找剧', '真人剧', '社区', '漫剧', '电影', '听书', '小说', '漫画', '长征', '经典', '知识'] as const;
type Cat = (typeof CATS)[number];

/** 上游有对应频道的三个 Tab；其余频道先给明确提示，不做假数据。 */
const CAT_TAB: Partial<Record<Cat, FeedTab>> = {
  找剧: 'recommend',
  真人剧: 'live',
  漫剧: 'anime',
};

function coverUrl(drama: Drama): string {
  return drama.cover !== '' ? drama.cover : `/api/poster/${drama.seriesId}`;
}

function pct(positionSec: number, durationSec: number): number {
  if (durationSec <= 0) return 0;
  return Math.max(2, Math.min(100, Math.round((positionSec / durationSec) * 100)));
}

interface Item {
  drama: Drama;
  /** 卡片底部小标签：分类或连载状态 */
  tag: string;
}

function mergeSections(sections: Array<{ tabName: string; items: Drama[] }>): Item[] {
  const seen = new Map<string, Item>();
  for (const section of sections) {
    for (const drama of section.items) {
      if (!seen.has(drama.seriesId)) {
        seen.set(drama.seriesId, {
          drama,
          tag: drama.tags[0] ?? (drama.finished ? '已完结' : '短剧'),
        });
      }
    }
  }
  return [...seen.values()];
}

/** 估算卡片高度，把卡片分到较短的一列（官方是高度不等的瀑布流）。 */
function splitColumns(items: Item[], rightStart: number, cardWidth: number, count: number): Item[][] {
  const columns: Item[][] = Array.from({ length: count }, () => []);
  const heights: number[] = Array.from({ length: count }, (_, index) => (index === count - 1 ? rightStart : 0));
  const posterH = cardWidth * 4 / 3;
  for (const item of items) {
    const lines = item.drama.title.length > 10 ? 2 : 1;
    const height = posterH + 8 + lines * 20 + 26 + 10;
    let index = 0;
    for (let i = 1; i < count; i += 1) {
      if (heights[i]! < heights[index]!) index = i;
    }
    columns[index]!.push(item);
    heights[index]! += height;
  }
  return columns;
}

function TheaterCard({ item, onOpen }: { item: Item; onOpen: (id: string) => void }): JSX.Element {
  const { drama, tag } = item;
  return (
    <button type="button" className="mt-card" onClick={() => onOpen(drama.seriesId)}>
      <span className="mt-card__poster">
        <img src={coverUrl(drama)} alt="" loading="lazy" decoding="async" />
        {drama.heatText !== '' ? (
          <span className="mt-card__heat">{drama.heatText}</span>
        ) : drama.episodeCount > 0 ? (
          <span className="mt-card__heat mt-card__heat--plain">全 {drama.episodeCount} 集</span>
        ) : null}
      </span>
      <span className="mt-card__body">
        <span className="mt-card__title">{drama.title}</span>
        <span className="mt-card__tag">
          {tag}
          {drama.episodeCount > 0 ? ` · 全${drama.episodeCount}集` : ''}
        </span>
      </span>
    </button>
  );
}

function ContinueCard({ entry, onPlay }: { entry: ProgressEntry; onPlay: () => void }): JSX.Element {
  return (
    <button type="button" className="mt-cont" onClick={onPlay}>
      <span className="mt-cont__row">
        <img className="mt-cont__poster" src={entry.cover !== '' ? entry.cover : `/api/poster/${entry.seriesId}`} alt="" />
        <span className="mt-cont__text">
          <span className="mt-cont__title">{entry.seriesTitle}</span>
          <span className="mt-cont__meta">
            已看到 {entry.episodeNo} 集 · {pct(entry.positionSec, entry.durationSec)}%
          </span>
        </span>
      </span>
      <span className="mt-cont__btn">
        <Icon name="play" size={12} /> 继续播放
      </span>
    </button>
  );
}

function Skeleton({ columns }: { columns: number }): JSX.Element {
  return (
    <div className="mt-waterfall" aria-hidden="true">
      {Array.from({ length: columns }, (_, col) => (
        <div className="mt-col" key={col}>
          {[0, 1, 2].map((i) => (
            <div className="mt-sk" key={i}>
              <span className="mt-sk__poster" />
              <span className="mt-sk__line" />
              <span className="mt-sk__line mt-sk__line--short" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function useColumns(): number {
  const [columns, setColumns] = useState(() => (window.matchMedia('(min-width: 600px)').matches ? 3 : 2));
  useEffect(() => {
    const query = window.matchMedia('(min-width: 600px)');
    const onChange = (): void => setColumns(query.matches ? 3 : 2);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return columns;
}

export function Home(): JSX.Element {
  const { go, openDetail, play } = useNav();
  const [cat, setCat] = useState<Cat>('找剧');
  const columns = useColumns();
  const home = useAsync((signal) => api.home(signal), [], readSnapshot<HomeSection[]>('home'));
  const cont = useAsync((signal) => api.continueWatching(4, signal), [], readSnapshot<ProgressEntry[]>('continue'));
  const [extra, setExtra] = useState<Item[]>([]);
  const [cursor, setCursor] = useState('');
  const [hasMore, setHasMore] = useState(true);
  const [nextLoading, setNextLoading] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (home.data !== null) writeSnapshot('home', home.data);
  }, [home.data]);
  useEffect(() => {
    if (cont.data !== null) writeSnapshot('continue', cont.data);
  }, [cont.data]);

  const merged = useMemo(() => mergeSections(home.data ?? []), [home.data]);
  const supported = CAT_TAB[cat] !== undefined;

  const baseItems: Item[] = useMemo(() => {
    if (cat === '找剧') return merged;
    if (supported) return extra;
    return [];
  }, [cat, merged, supported, extra]);

  // 标记当前列表里已有的剧，续页时按 id 去重
  useEffect(() => {
    seenRef.current = new Set(baseItems.map((item) => item.drama.seriesId));
  }, [baseItems]);

  // 切频道：清空续页，卷回顶部
  useEffect(() => {
    setExtra([]);
    setCursor('');
    setHasMore(true);
    setNextLoading(false);
    const scroller = document.querySelector<HTMLElement>('.m-scroll');
    if (scroller !== null) scroller.scrollTop = 0;
  }, [cat]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (!supported || nextLoading || !hasMore) return;
    const tab = CAT_TAB[cat];
    if (tab === undefined) return;
    setNextLoading(true);
    try {
      let nextCursor = cursor;
      let appended = 0;
      // 首页自带的一屏可能和 feed 第一页重合：最多翻 3 页，直到拿到新剧或没有更多
      for (let round = 0; round < 3; round += 1) {
        const page = await api.feed(nextCursor, tab, false);
        nextCursor = page.cursor;
        const fresh: Item[] = [];
        for (const drama of page.items) {
          if (seenRef.current.has(drama.seriesId)) continue;
          seenRef.current.add(drama.seriesId);
          fresh.push({ drama, tag: drama.tags[0] ?? (drama.finished ? '已完结' : '短剧') });
        }
        if (fresh.length > 0) {
          setExtra((old) => [...old, ...fresh]);
          appended += fresh.length;
        }
        if (!page.hasMore || appended > 0) {
          setCursor(nextCursor);
          setHasMore(page.hasMore);
          if (appended > 0) return;
          if (!page.hasMore) return;
        }
        if (round === 2) {
          setCursor(nextCursor);
          setHasMore(page.hasMore);
        }
      }
    } catch {
      // 续页失败不打断当前浏览，下一次触底会再试
    } finally {
      setNextLoading(false);
    }
  }, [cat, cursor, hasMore, nextLoading, supported]);

  useEffect(() => {
    if (!supported) return;
    const node = sentinelRef.current;
    if (node === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { rootMargin: '320px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMore, supported]);

  const items = useMemo(() => {
    if (cat === '找剧') {
      const seen = new Set<string>();
      return [...merged, ...extra].filter((item) => {
        if (seen.has(item.drama.seriesId)) return false;
        seen.add(item.drama.seriesId);
        return true;
      });
    }
    return extra;
  }, [cat, merged, extra]);

  const loading = home.loading && merged.length === 0;
  const error = cat === '找剧' ? home.error : null;
  const empty = !loading && error === null && items.length === 0 && (!supported || !nextLoading);
  const continueEntry = cat === '找剧' ? (cont.data?.[0] ?? null) : null;
  const cardWidth = Math.max(120, Math.floor((Math.min(window.innerWidth, 980) - 24) / columns) - 8);
  const cols = splitColumns(items, continueEntry === null ? 0 : 150, cardWidth, columns);

  const pickCat = (next: Cat): void => {
    if (next === cat) return;
    setCat(next);
  };

  return (
    <div className="mt">
      <div className="mt-search">
        <button type="button" className="mt-search__box" onClick={() => go('search')} aria-label="搜索">
          <Icon name="search" size={15} />
          <span className="mt-search__ph">1000集以上的完结短剧爆剧</span>
        </button>
      </div>

      <div className="mt-cats">
        {CATS.map((name) => (
          <button
            key={name}
            type="button"
            className="mt-cat"
            data-active={name === cat}
            onClick={() => pickCat(name)}
          >
            {name}
          </button>
        ))}
      </div>

      <div className="mt-acts">
        <button type="button" className="mt-act" data-kind="filter" onClick={() => go('category')}>
          <span className="mt-act__icon"><Icon name="funnel" size={13} /></span>筛选
        </button>
        <button type="button" className="mt-act" data-kind="rank" onClick={() => go('rank')}>
          <span className="mt-act__icon"><Icon name="flame" size={13} /></span>排行榜
        </button>
        <button type="button" className="mt-act" data-kind="new" onClick={() => go('new')}>
          <span className="mt-act__icon"><Icon name="play" size={13} solid /></span>新剧
        </button>
        <button type="button" className="mt-act" data-kind="reserve" onClick={() => go('new')}>
          <span className="mt-act__icon"><Icon name="grid" size={13} solid /></span>预约
        </button>
      </div>

      {loading && <Skeleton columns={columns} />}
      {!loading && error !== null && (
        <div className="mt-empty">
          <p>{error}</p>
          <button type="button" onClick={() => home.reload()}>重试</button>
        </div>
      )}
      {!loading && error === null && !supported && (
        <div className="mt-empty">
          <p>{cat}频道暂未接入，先从「找剧」看起</p>
          <button type="button" onClick={() => setCat('找剧')}>去找剧</button>
        </div>
      )}
      {empty && supported && (
        <div className="mt-empty">
          <p>{nextLoading ? '正在加载…' : `${cat}暂无内容`}</p>
          <button type="button" onClick={() => setCat('找剧')}>去找剧</button>
        </div>
      )}

      {!loading && items.length > 0 && (
        <div className="mt-waterfall" data-cols={columns}>
          {cols.map((column, index) => (
            <div className="mt-col" key={index}>
              {index === columns - 1 && continueEntry !== null && (
                <ContinueCard
                  entry={continueEntry}
                  onPlay={() => play(continueEntry.seriesId, continueEntry.episodeId, continueEntry.episodeNo)}
                />
              )}
              {column.map((item) => (
                <TheaterCard key={item.drama.seriesId} item={item} onOpen={openDetail} />
              ))}
            </div>
          ))}
        </div>
      )}

      {supported && (
        <div ref={sentinelRef} className="mt-more" aria-live="polite">
          {nextLoading ? '加载中…' : hasMore ? '上滑加载更多' : '已经到底了'}
        </div>
      )}
    </div>
  );
}
