import { useRef, useState } from 'react';
import type { JSX } from 'react';
import { api, coverOf, type RankEntry, type RankGroup } from '../api.ts';
import { Page } from '../ui/Page.tsx';
import { InfiniteSentinel } from '../ui/InfiniteSentinel.tsx';
import { StateBlock } from '../ui/StateBlock.tsx';
import { usePaged } from '../hooks/usePaged.ts';
import { useApp } from '../store.ts';

/** 名次前三名用暖橙渐变，其余用普通序号。 */
function RankNo({ rank }: { rank: number }): JSX.Element {
  return (
    <span className="rank-row__no" data-top={rank <= 3}>
      {rank}
    </span>
  );
}

export function Rank(): JSX.Element {
  const [content, setContent] = useState('');
  const [board, setBoard] = useState('');
  const [groups, setGroups] = useState<RankGroup[]>([]);
  const openDetail = useApp((s) => s.openDetail);
  // 榜单用游标翻页：下一页必须带上一页返回的 cursor
  const cursorRef = useRef('');

  const { items, loading, error, hasMore, moreLoading, loadMore, reload } = usePaged<RankEntry>(
    [content, board],
    async (page, signal) => {
      const res = await api.rank(content, board, page === 1 ? '' : cursorRef.current, signal);
      cursorRef.current = res.cursor;
      if (page === 1) setGroups(res.groups);
      return { items: res.items, page, hasMore: res.hasMore };
    },
    { idOf: (e) => (e.kind === 'series' ? `s-${e.drama.seriesId}` : `a-${e.userId}`) },
  );

  // 未选择时按第一组/第一个榜展示（后端默认值就是这个，不用额外请求）
  const activeGroup = groups.find((g) => g.id === content) ?? groups[0];
  const activeBoard = activeGroup?.boards.some((b) => b.id === board)
    ? board
    : (activeGroup?.boards[0]?.id ?? '');

  return (
    <Page title="榜单" sub="全部 · 真人 · 漫剧 · 演员">
      {groups.length > 0 && (
        <div className="board-tabs" role="tablist" aria-label="榜单分类">
          {groups.map((g) => (
            <button
              key={g.id}
              role="tab"
              aria-selected={g.id === (activeGroup?.id ?? '')}
              className={`chip${g.id === (activeGroup?.id ?? '') ? ' chip--on' : ''}`}
              onClick={() => {
                setContent(g.id);
                setBoard(g.boards[0]?.id ?? '');
              }}
            >
              {g.name}
            </button>
          ))}
        </div>
      )}

      {activeGroup !== undefined && activeGroup.boards.length > 0 && (
        <div className="board-tabs" role="tablist" aria-label="榜单">
          {activeGroup.boards.map((b) => (
            <button
              key={b.id}
              role="tab"
              aria-selected={b.id === activeBoard}
              className={`chip${b.id === activeBoard ? ' chip--on' : ''}`}
              onClick={() => setBoard(b.id)}
            >
              {b.name}
            </button>
          ))}
        </div>
      )}

      <StateBlock loading={loading} error={error} empty={!loading && error === null && items.length === 0} onRetry={reload}>
        <div className="rank-list">
          {items.map((entry, index) => {
            const rank = entry.rank > 0 ? entry.rank : index + 1;
            if (entry.kind === 'actor') {
              const src = entry.avatar === '' ? '' : `/api/img?url=${encodeURIComponent(entry.avatar)}`;
              return (
                <article className="rank-row rank-row--actor" key={`a-${entry.userId}`}>
                  <RankNo rank={rank} />
                  <div className="rank-row__avatar">
                    {src !== '' ? <img src={src} alt="" loading="lazy" /> : <div className="drama-card__empty" />}
                  </div>
                  <div className="rank-row__main">
                    <h3 className="rank-row__title">{entry.name}</h3>
                    <p className="rank-row__meta">{entry.score !== '' ? entry.score : '演员'}</p>
                    {entry.intro !== '' && <p className="rank-row__intro">{entry.intro}</p>}
                  </div>
                </article>
              );
            }

            const cover = entry.drama.cover !== '' ? coverOf(entry.drama) : `/api/poster/${entry.drama.seriesId}`;
            const meta = [entry.drama.episodeCount > 0 ? `${entry.drama.episodeCount} 集` : '短剧', entry.score !== '' ? entry.score : entry.drama.heatText]
              .filter((t) => t !== '')
              .join(' · ');
            return (
              <article
                className="rank-row"
                key={`s-${entry.drama.seriesId}`}
                role="button"
                tabIndex={0}
                onClick={() => openDetail(entry.drama.seriesId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openDetail(entry.drama.seriesId);
                  }
                }}
              >
                <RankNo rank={rank} />
                <div className="rank-row__cover">
                  {cover !== '' ? <img src={cover} alt="" loading="lazy" decoding="async" /> : <div className="drama-card__empty" />}
                  {entry.drama.finished && <span className="rank-row__badge">完结</span>}
                </div>
                <div className="rank-row__main">
                  <h3 className="rank-row__title">{entry.drama.title}</h3>
                  <p className="rank-row__meta">{meta}</p>
                  {entry.drama.intro !== '' && <p className="rank-row__intro">{entry.drama.intro}</p>}
                </div>
                <span className="rank-row__chev" aria-hidden="true">
                  ›
                </span>
              </article>
            );
          })}
        </div>
        <InfiniteSentinel onReach={loadMore} disabled={!hasMore || loading} />
        <p className="load-more__hint">{moreLoading ? '加载中…' : hasMore ? '继续下滑自动加载' : '没有更多了'}</p>
      </StateBlock>
    </Page>
  );
}
