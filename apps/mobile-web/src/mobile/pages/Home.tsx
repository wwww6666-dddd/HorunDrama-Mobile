/**
 * 剧场页：对齐官方 7.4.5.32「找剧」。
 *
 * 结构（从上到下）：
 *   搜索框 + 识剧 + AI 头像 → 频道标签条 → 四胶囊（筛选/排行榜/新剧/预约）
 *   → 双列瀑布（右列顶部放「继续观看」卡）。
 *
 * 主题：官方剧场是浅色，本页单独覆盖为 #f5f5f6 + 白卡；推荐流仍保持深色。
 */
import type { JSX } from 'react';
import { useState } from 'react';
import { api, type Drama, type ProgressEntry } from '../../api.ts';
import { useAsync } from '../../hooks/useAsync.ts';
import { useNav } from '../nav.tsx';
import { Icon } from '../ui.tsx';

const CATS = ['找剧', '真人剧', '社区', '漫剧', '电影', '听书', '小说'] as const;
type Cat = (typeof CATS)[number];

function coverUrl(drama: Drama): string {
  return drama.cover !== '' ? drama.cover : `/api/poster/${drama.seriesId}`;
}

function pct(positionSec: number, durationSec: number): number {
  if (durationSec <= 0) return 0;
  return Math.max(2, Math.min(100, Math.round((positionSec / durationSec) * 100)));
}

interface Item {
  drama: Drama;
  /** 卡片底部小标签：分类或推荐位 */
  tag: string;
}

function mergeSections(sections: Array<{ tabName: string; items: Drama[] }>): Item[] {
  const seen = new Map<string, Item>();
  for (const section of sections) {
    for (const drama of section.items) {
      if (!seen.has(drama.seriesId)) {
        seen.set(drama.seriesId, {
          drama,
          tag: drama.tags[0] ?? section.tabName,
        });
      }
    }
  }
  return [...seen.values()];
}

/** 估算卡片高度，把卡片分到较短的一列（官方是高度不等的双列瀑布）。 */
function splitColumns(items: Item[], rightStart: number, cardWidth: number): [Item[], Item[]] {
  const columns: [Item[], Item[]] = [[], []];
  const heights: [number, number] = [0, rightStart];
  const posterH = cardWidth * 4 / 3;
  for (const item of items) {
    const lines = item.drama.title.length > 10 ? 2 : 1;
    const height = posterH + 8 + lines * 20 + 26 + 10;
    const index: 0 | 1 = heights[0] <= heights[1] ? 0 : 1;
    columns[index].push(item);
    heights[index] += height;
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

function Skeleton(): JSX.Element {
  return (
    <div className="mt-waterfall" aria-hidden="true">
      {[0, 1].map((col) => (
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

export function Home(): JSX.Element {
  const { go, openDetail, play } = useNav();
  const [cat, setCat] = useState<Cat>('找剧');
  const home = useAsync((signal) => api.home(signal), []);
  const cont = useAsync((signal) => api.continueWatching(4, signal), []);
  const feed = useAsync(async (signal) => {
    if (cat === '真人剧') return (await api.feed('', 'live', false, signal)).items;
    if (cat === '漫剧') return (await api.feed('', 'anime', false, signal)).items;
    return [];
  }, [cat]);

  const merged = mergeSections(home.data ?? []);
  const items: Item[] =
    cat === '找剧'
      ? merged
      : (feed.data ?? []).map((drama) => ({ drama, tag: drama.tags[0] ?? '短剧' }));

  const loading = home.loading || (cat !== '找剧' && feed.loading);
  const error = cat === '找剧' ? home.error : feed.error;
  const empty = !loading && error === null && items.length === 0;
  const continueEntry = cat === '找剧' ? (cont.data?.[0] ?? null) : null;
  const [left, right] = splitColumns(items, continueEntry === null ? 0 : 150, 170);
  const placeholder = merged[0]?.drama.title ?? '剧名、演员、剧情关键词';

  const pickCat = (next: Cat): void => {
    if (next === cat) return;
    setCat(next);
  };

  return (
    <div className="mt">
      <div className="mt-search">
        <button type="button" className="mt-search__box" onClick={() => go('search')} aria-label="搜索">
          <Icon name="search" size={15} />
          <span className="mt-search__ph">{placeholder}</span>
        </button>
        <button type="button" className="mt-search__scan" onClick={() => go('search')}>
          <Icon name="search" size={13} /> 识剧
        </button>
        <button type="button" className="mt-avatar" onClick={() => go('me')} aria-label="我的" />
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
          <span className="mt-act__icon"><Icon name="filter" size={13} /></span>筛选
        </button>
        <button type="button" className="mt-act" data-kind="rank" onClick={() => go('rank')}>
          <span className="mt-act__icon"><Icon name="rank" size={13} /></span>排行榜
        </button>
        <button type="button" className="mt-act" data-kind="new" onClick={() => go('new')}>
          <span className="mt-act__icon"><Icon name="tv" size={13} /></span>新剧
        </button>
        <button type="button" className="mt-act" data-kind="reserve" onClick={() => go('new')}>
          <span className="mt-act__icon"><Icon name="clock" size={13} /></span>预约
        </button>
      </div>

      {loading && <Skeleton />}
      {!loading && error !== null && (
        <div className="mt-empty">
          <p>{error}</p>
          <button type="button" onClick={() => (cat === '找剧' ? home.reload() : feed.reload())}>重试</button>
        </div>
      )}
      {!loading && error === null && (cat === '社区' || cat === '电影' || cat === '听书' || cat === '小说') && (
        <div className="mt-empty">
          <p>{cat}频道暂未接入，先从「找剧」看起</p>
          <button type="button" onClick={() => setCat('找剧')}>去找剧</button>
        </div>
      )}
      {empty && !(cat === '社区' || cat === '电影' || cat === '听书' || cat === '小说') && (
        <div className="mt-empty">
          <p>{cat}暂无内容</p>
          <button type="button" onClick={() => setCat('找剧')}>去找剧</button>
        </div>
      )}

      {!loading && items.length > 0 && (
        <div className="mt-waterfall">
          <div className="mt-col">
            {left.map((item) => (
              <TheaterCard key={item.drama.seriesId} item={item} onOpen={openDetail} />
            ))}
          </div>
          <div className="mt-col">
            {continueEntry !== null && (
              <ContinueCard
                entry={continueEntry}
                onPlay={() => play(continueEntry.seriesId, continueEntry.episodeId, continueEntry.episodeNo)}
              />
            )}
            {right.map((item) => (
              <TheaterCard key={item.drama.seriesId} item={item} onOpen={openDetail} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
