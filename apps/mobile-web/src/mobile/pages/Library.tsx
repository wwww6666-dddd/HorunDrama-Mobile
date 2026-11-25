import type { JSX } from 'react';
import { useState } from 'react';
import { api } from '../../api.ts';
import { useAsync } from '../../hooks/useAsync.ts';
import { PageTitle } from '../PageTitle.tsx';
import { useNav } from '../nav.tsx';
import { Empty, Icon, Segmented, Skeleton } from '../ui.tsx';

interface LibCard {
  seriesId: string;
  title: string;
  cover: string;
  meta: string;
  badge?: string;
  episodeId?: string;
  episodeNo?: number;
}

export function Library(): JSX.Element {
  const { openDetail, play, go } = useNav();
  const [tab, setTab] = useState<'fav' | 'history' | 'likes' | 'follow'>('fav');

  const list = useAsync<LibCard[]>(async (signal) => {
    if (tab === 'fav') {
      const rows = await api.favorites(signal);
      return rows.map((r) => ({
        seriesId: r.seriesId,
        title: r.seriesTitle,
        cover: r.cover !== '' ? r.cover : `/api/poster/${r.seriesId}`,
        meta: r.episodeCount > 0 ? `${r.episodeCount} 集` : '短剧',
      }));
    }
    if (tab === 'history') {
      const rows = await api.continueWatching(40, signal);
      return rows.map((r) => ({
        seriesId: r.seriesId,
        title: r.seriesTitle,
        cover: r.cover !== '' ? r.cover : `/api/poster/${r.seriesId}`,
        meta: `看到第 ${r.episodeNo} 集`,
        badge: r.durationSec > 0 ? `${Math.round((r.positionSec / r.durationSec) * 100)}%` : undefined,
        episodeId: r.episodeId,
        episodeNo: r.episodeNo,
      }));
    }
    if (tab === 'likes') {
      const rows = await api.likes(signal);
      return rows.map((r) => ({
        seriesId: r.seriesId,
        title: r.seriesTitle,
        cover: r.cover !== '' ? r.cover : `/api/poster/${r.seriesId}`,
        meta: r.episodeCount > 0 ? `${r.episodeCount} 集` : '短剧',
      }));
    }
    const rows = await api.follows(signal);
    return rows.map((r) => ({
      seriesId: r.seriesId,
      title: r.seriesTitle,
      cover: r.cover !== '' ? r.cover : `/api/poster/${r.seriesId}`,
      meta: r.latestCount > 0 ? `更到 ${r.latestCount} 集` : `${r.episodeCount} 集`,
      badge: r.hasNew ? '有新集' : undefined,
    }));
  }, [tab]);

  const rows = list.data ?? [];

  return (
    <>
      <PageTitle
        title="追剧"
        sub="收藏 · 历史 · 点赞 · 追更"
        actions={
          <button className="m-iconbtn m-iconbtn--glass" type="button" aria-label="下载管理" onClick={() => go('downloads')}>
            <Icon name="download" size={18} />
          </button>
        }
      />

      <Segmented
        items={[
          { value: 'fav', label: '收藏' },
          { value: 'history', label: '历史' },
          { value: 'likes', label: '点赞' },
          { value: 'follow', label: '追更' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {list.loading && <Skeleton variant="grid" rows={4} />}
      {list.error !== null && <Empty text={list.error} action={<button className="m-btn" type="button" onClick={list.reload}>重试</button>} />}

      {rows.length > 0 && (
        <div className="m-grid">
          {rows.map((row) => (
            <article className="m-gcard" key={`${tab}-${row.seriesId}`} onClick={() => openDetail(row.seriesId)}>
              <div className="m-gcard__poster">
                <img src={row.cover} alt="" loading="lazy" decoding="async" />
                {row.badge !== undefined && <span className="m-gcard__badge">{row.badge}</span>}
                {row.episodeId !== undefined && (
                  <span
                    className="m-gcard__play"
                    role="button"
                    aria-label="继续播放"
                    onClick={(e) => {
                      e.stopPropagation();
                      play(row.seriesId, row.episodeId ?? '', row.episodeNo ?? 1);
                    }}
                  >
                    <Icon name="play" size={13} />
                  </span>
                )}
              </div>
              <p className="m-gcard__title">{row.title}</p>
              <p className="m-gcard__meta">{row.meta}</p>
            </article>
          ))}
        </div>
      )}

      {!list.loading && rows.length === 0 && list.error === null && (
        <Empty
          text={tab === 'fav' ? '还没有收藏的剧' : tab === 'likes' ? '还没有点过赞' : tab === 'follow' ? '还没有追更的剧' : '还没有观看记录'}
          action={
            <button className="m-btn m-btn--primary" type="button" onClick={() => go('home')}>
              去剧场找片
            </button>
          }
        />
      )}
    </>
  );
}


