import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { createPortal } from 'react-dom';
import { api, type SeriesDetail } from '../api.ts';
import { useApp } from '../store.ts';
import { useAsync } from '../hooks/useAsync.ts';
import { playHash } from '../routes.ts';
import { DramaCard } from './DramaCard.tsx';

/**
 * 详情抽屉：右侧滑出，点遮罩 / Esc / 切页面都会收起。
 *
 * 2.0.0 起用 portal 挂到「当前全屏元素」而不是固定 body：
 * 网页全屏时浏览器只渲染全屏元素子树，挂 body 的详情会被直接藏掉
 * （用户反馈的"全屏里点查看详细没反应"就是这个原因）。
 */
export function DetailDrawer({ seriesId }: { seriesId: string }): JSX.Element {
  const closeDetail = useApp((s) => s.closeDetail);
  const { data, error, loading, reload } = useAsync((signal) => api.series(seriesId, signal), [seriesId]);
  const [root, setRoot] = useState<HTMLElement>(
    () => (document.fullscreenElement as HTMLElement | null) ?? document.body,
  );

  // 全屏状态变化时把抽屉搬到新的全屏宿主里（退出全屏再搬回 body）
  useEffect(() => {
    const sync = (): void => setRoot((document.fullscreenElement as HTMLElement | null) ?? document.body);
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeDetail();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeDetail]);

  return createPortal(
    <>
      <div className="detail-backdrop" onClick={closeDetail} />
      <aside
        className="detail-panel"
        role="dialog"
        aria-modal="true"
        aria-label={data?.drama.title ?? '剧集详情'}
      >
        <button className="detail-close" onClick={closeDetail} title="收起" aria-label="收起">
          ✕
        </button>

        {loading && (
          <div className="detail-body">
            <div className="skeleton" style={{ height: 176, borderRadius: 14 }} />
            <div className="skeleton" style={{ height: 20, marginTop: 16, width: '60%' }} />
            <div className="skeleton" style={{ height: 14, marginTop: 10, width: '90%' }} />
          </div>
        )}

        {error !== null && (
          <div className="detail-body">
            <p className="state state--error">{error}</p>
            <button className="btn" onClick={reload}>
              重试
            </button>
          </div>
        )}

        {data !== null && <DetailBody detail={data} />}
      </aside>
    </>,
    root,
  );
}

/** 详情主体：头部封面/剧名/操作，下面选集与相关推荐。 */
function DetailBody({ detail }: { detail: SeriesDetail }): JSX.Element {
  const { drama, tags, episodes, recommendations, seasons } = detail;
  const fav = useAsync((signal) => api.favoriteFor(drama.seriesId, signal), [drama.seriesId]);
  const like = useAsync((signal) => api.likeFor(drama.seriesId, signal), [drama.seriesId]);
  const follow = useAsync((signal) => api.followFor(drama.seriesId, signal), [drama.seriesId]);
  const isFav = fav.data?.favorite === true;
  const isLiked = like.data?.liked === true;
  const isFollowing = follow.data?.following === true;
  const setView = useApp((s) => s.setView);
  const [downloading, setDownloading] = useState(false);
  const [dlNote, setDlNote] = useState('');
  const [actNote, setActNote] = useState('');
  const [showAllEpisodes, setShowAllEpisodes] = useState(false);
  const shownEpisodes = showAllEpisodes ? episodes : episodes.slice(0, 120);
  const cover = drama.cover !== '' ? `/api/img?url=${encodeURIComponent(drama.cover)}` : `/api/poster/${drama.seriesId}`;

  /** 一键把可播放的分集加入下载队列。 */
  const downloadAll = async (): Promise<void> => {
    const playable = episodes.filter((ep) => ep.playable);
    if (playable.length === 0) {
      setDlNote('这部剧暂时没有可下载的分集');
      return;
    }
    setDownloading(true);
    try {
      const res = await api.addDownloads({
        seriesId: drama.seriesId,
        seriesTitle: drama.title,
        cover: drama.cover,
        episodes: playable.map((ep) => ({ episodeId: ep.episodeId, no: ep.no })),
      });
      setDlNote(res.queued > 0 ? `已加入下载队列：${res.queued} 集` : '这些分集已经在队列里了');
    } catch (err) {
      setDlNote(`下载失败：${(err as Error).message}`);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="detail-body">
      <header className="detail-head">
        <div className="detail-cover">
          <img src={cover} alt="" />
        </div>
        <div className="detail-info">
          <h2 className="detail-title">{drama.title}</h2>
          <p className="detail-meta">
            {drama.episodeCount > 0 ? `共 ${drama.episodeCount} 集` : '短剧'}
            {drama.heatText !== '' && ` · ${drama.heatText}`}
            {drama.finished && ' · 已完结'}
          </p>
          {tags.length > 0 && (
            <div className="detail-tags">
              {tags.map((t) => (
                <span className="chip" key={t}>
                  {t}
                </span>
              ))}
            </div>
          )}
          <div className="detail-actions">
            <button
              className={`btn${isFav ? ' btn--primary' : ''}`}
              onClick={async () => {
                try {
                  await api.toggleFavorite({
                    seriesId: drama.seriesId,
                    seriesTitle: drama.title,
                    cover: drama.cover,
                    episodeCount: drama.episodeCount,
                  });
                  setActNote('');
                  fav.reload();
                } catch (err) {
                  setActNote((err as Error).message);
                }
              }}
            >
              {isFav ? '已收藏' : '收藏'}
            </button>
            <button
              className={`btn${isLiked ? ' btn--primary' : ''}`}
              disabled={episodes.find((ep) => ep.playable) === undefined}
              onClick={async () => {
                try {
                  await api.toggleLike({
                    seriesId: drama.seriesId,
                    seriesTitle: drama.title,
                    cover: drama.cover,
                    episodeCount: drama.episodeCount,
                    episodeId: episodes.find((ep) => ep.playable)?.episodeId ?? '',
                  });
                  setActNote('');
                  like.reload();
                } catch (err) {
                  setActNote((err as Error).message);
                }
              }}
            >
              {isLiked ? '已点赞' : '点赞'}
            </button>
            <button
              className={`btn${isFollowing ? ' btn--primary' : ''}`}
              title="追更记录在本机，登录后可同步"
              onClick={async () => {
                try {
                  await api.toggleFollow({
                    seriesId: drama.seriesId,
                    seriesTitle: drama.title,
                    cover: drama.cover,
                    episodeCount: drama.episodeCount,
                  });
                  setActNote('');
                  follow.reload();
                } catch (err) {
                  setActNote((err as Error).message);
                }
              }}
            >
              {isFollowing ? '已追更' : '追更'}
            </button>
            <button className="btn" disabled={downloading} onClick={() => void downloadAll()}>
              {downloading ? '加入中…' : '下载本剧'}
            </button>
            {dlNote !== '' && (
              <button className="btn btn--ghost" onClick={() => setView('downloads')}>
                查看下载
              </button>
            )}
          </div>
          {actNote !== '' && <p className="detail-hint detail-hint--note">{actNote}</p>}
          {dlNote !== '' && <p className="detail-hint detail-hint--note">{dlNote}</p>}
        </div>
      </header>

      {drama.intro !== '' && <p className="detail-intro">{drama.intro}</p>}

      {seasons.length > 0 && (
        <section className="detail-section">
          <h3 className="detail-section__title">其他季</h3>
          <div className="detail-seasons">
            {seasons.map((s) => (
              <DramaCard key={s.seriesId} drama={s} />
            ))}
          </div>
        </section>
      )}

      <section className="detail-section">
        <h3 className="detail-section__title">
          选集 <span className="detail-count">{episodes.length} 集</span>
        </h3>
        <div className="ep-grid">
          {shownEpisodes.map((ep) => (
            <button
              key={ep.episodeId}
              className="ep-btn"
              disabled={!ep.playable}
              title={`播放第 ${ep.no} 集`}
              onClick={() => {
                location.hash = playHash(drama.seriesId, ep.episodeId, ep.no);
              }}
            >
              {ep.no}
            </button>
          ))}
        </div>
        {episodes.length > 120 && !showAllEpisodes && (
          <button className="btn btn--ghost detail-more" onClick={() => setShowAllEpisodes(true)}>
            展开全部 {episodes.length} 集
          </button>
        )}
        <p className="detail-hint">点集数开始播放；首次播放会做一次解密转码，之后同一集秒开</p>
      </section>

      {recommendations.length > 0 && (
        <section className="detail-section">
          <h3 className="detail-section__title">相关推荐</h3>
          <div className="detail-reco">
            {recommendations.map((d) => (
              <DramaCard key={d.seriesId} drama={d} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
