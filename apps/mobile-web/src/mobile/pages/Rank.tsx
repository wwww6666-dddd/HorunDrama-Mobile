import { useState } from 'react';
import type { JSX } from 'react';
import { api, coverOf, type RankEntry } from '../../api.ts';
import { useAsync } from '../../hooks/useAsync.ts';
import { PageTitle } from '../PageTitle.tsx';
import { useNav } from '../nav.tsx';
import { Empty, Icon, Skeleton } from '../ui.tsx';

function entryCover(entry: RankEntry): string {
  return entry.kind === 'series' ? coverOf(entry.drama) : `/api/img?url=${encodeURIComponent(entry.avatar)}`;
}

export function Rank(): JSX.Element {
  const { openDetail } = useNav();
  const [content, setContent] = useState('');
  const [board, setBoard] = useState('');
  const page = useAsync((signal) => api.rank(content, board, '', signal), [content, board]);

  const groups = page.data?.groups ?? [];
  const group = groups.find((g) => g.id === content) ?? groups[0];
  const activeBoard = group?.boards.some((b) => b.id === board) ? board : (group?.boards[0]?.id ?? '');
  const items = page.data?.items ?? [];

  return (
    <>
      <PageTitle title="榜单" sub={group?.name ?? '实时热榜'} />

      {groups.length > 0 && (
        <div className="m-chips" role="tablist" aria-label="榜单分类">
          {groups.map((g) => (
            <button
              key={g.id}
              type="button"
              role="tab"
              className="m-chip"
              data-active={g.id === group?.id}
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

      {group !== undefined && group.boards.length > 1 && (
        <div className="m-chips m-chips--sub" role="tablist" aria-label="榜单">
          {group.boards.map((b) => (
            <button
              key={b.id}
              type="button"
              role="tab"
              className="m-chip m-chip--sm"
              data-active={b.id === activeBoard}
              onClick={() => setBoard(b.id)}
            >
              {b.name}
            </button>
          ))}
        </div>
      )}

      {page.loading && <Skeleton rows={6} />}
      {page.error !== null && <Empty text={page.error} action={<button className="m-btn" type="button" onClick={page.reload}>重试</button>} />}

      <div className="m-list">
        {items.map((entry, index) => {
          const rank = entry.rank > 0 ? entry.rank : index + 1;
          if (entry.kind === 'actor') {
            return (
              <div className="m-lrow" key={`a-${entry.userId}`}>
                <span className="m-lrow__no" data-top={rank <= 3}>{rank}</span>
                <span className="m-lrow__avatar">
                  <img src={entryCover(entry)} alt="" loading="lazy" decoding="async" />
                </span>
                <div className="m-lrow__main">
                  <p className="m-lrow__title">{entry.name}</p>
                  <p className="m-lrow__meta">{entry.score !== '' ? entry.score : '演员'} · 演员</p>
                </div>
              </div>
            );
          }
          return (
            <button
              type="button"
              className="m-lrow"
              key={`s-${entry.drama.seriesId}`}
              onClick={() => openDetail(entry.drama.seriesId)}
            >
              <span className="m-lrow__no" data-top={rank <= 3}>{rank}</span>
              <span className="m-lrow__cover">
                <img src={entryCover(entry)} alt="" loading="lazy" decoding="async" />
              </span>
              <div className="m-lrow__main">
                <p className="m-lrow__title">{entry.drama.title}</p>
                <p className="m-lrow__meta">
                  {[entry.drama.episodeCount > 0 ? `${entry.drama.episodeCount} 集` : '短剧', entry.score !== '' ? entry.score : entry.drama.heatText]
                    .filter((t) => t !== '')
                    .join(' · ')}
                </p>
              </div>
              <Icon name="chevron" size={17} />
            </button>
          );
        })}
      </div>

      {!page.loading && items.length === 0 && page.error === null && <Empty text="这个榜单暂时没有数据" />}
    </>
  );
}



