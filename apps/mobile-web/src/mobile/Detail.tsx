import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { api, coverOf, type SeriesDetail } from '../api.ts';
import { useAsync } from '../hooks/useAsync.ts';
import { useNav } from './nav.tsx';
import { readSnapshot, writeSnapshot } from './snapshot.ts';
import { Empty, Icon, Loading } from './ui.tsx';

/** 剧集详情：iOS 风格的大封面抽屉，选集、追剧、收藏、批量下载 */
export function Detail({ seriesId, onOpen }: { seriesId: string; onOpen: (id: string) => void }): JSX.Element {
  const { play } = useNav();
  const series = useAsync(
    (signal) => api.series(seriesId, signal),
    [seriesId],
    readSnapshot<SeriesDetail>(`series:${seriesId}`),
  );
  const follow = useAsync((signal) => api.followFor(seriesId, signal), [seriesId]);
  const fav = useAsync((signal) => api.favoriteFor(seriesId, signal), [seriesId]);

  const [expand, setExpand] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState('');

  useEffect(() => {
    setExpand(false);
    setSelecting(false);
    setPicked([]);
    setNote('');
  }, [seriesId]);

  useEffect(() => {
    if (series.data !== null) writeSnapshot(`series:${seriesId}`, series.data);
  }, [series.data, seriesId]);

  const drama = series.data?.drama;
  const episodes = series.data?.episodes ?? [];
  const cover = drama === undefined ? '' : coverOf(drama);
  const following = follow.data?.following === true;
  const favorited = fav.data?.favorite === true;

  const toggleFollow = (): void => {
    if (drama === undefined) return;
    void api
      .toggleFollow({ seriesId, seriesTitle: drama.title, cover: drama.cover, episodeCount: drama.episodeCount })
      .then((r) => {
        setNote(r.following ? '已加入追剧' : '已取消追剧');
        follow.reload();
      })
      .catch((err: unknown) => setNote((err as Error).message));
  };

  const toggleFav = (): void => {
    if (drama === undefined) return;
    void api
      .toggleFavorite({ seriesId, seriesTitle: drama.title, cover: drama.cover, episodeCount: drama.episodeCount })
      .then((r) => {
        setNote(r.added ? '已收藏' : '已取消收藏');
        fav.reload();
      })
      .catch((err: unknown) => setNote((err as Error).message));
  };

  const queueDownload = (): void => {
    if (drama === undefined || picked.length === 0) return;
    const eps = episodes
      .filter((e) => picked.includes(e.episodeId))
      .map((e) => ({ episodeId: e.episodeId, no: e.no }));
    void api
      .addDownloads({ seriesId, seriesTitle: drama.title, cover: drama.cover, episodes: eps })
      .then((r) => {
        setNote(`已加入下载队列：${r.queued} 集`);
        setSelecting(false);
        setPicked([]);
      })
      .catch((err: unknown) => setNote(`下载失败：${(err as Error).message}`));
  };

  if (series.loading) return <Loading />;
  if (series.error !== null) return <Empty text={series.error} action={<button className="m-btn" type="button" onClick={series.reload}>重试</button>} />;
  if (drama === undefined) return <Empty text="没有这部剧" />;

  return (
    <div className="m-detail">
      <div className="m-detail__hero">
        <div className="m-detail__bg" style={{ backgroundImage: `url(${cover})` }} />
        <div className="m-detail__cover">
          <img src={cover} alt="" />
        </div>
        <div className="m-detail__head">
          <h2>{drama.title}</h2>
          <p className="m-detail__meta">
            {[drama.episodeCount > 0 ? `${drama.episodeCount} 集` : '短剧', drama.finished ? '完结' : '连载中', drama.heatText]
              .filter((t) => t !== '')
              .join(' · ')}
          </p>
          {drama.tags.length > 0 && (
            <div className="m-detail__tags">
              {drama.tags.slice(0, 4).map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="m-detail__actions">
        <button
          type="button"
          className="m-btn m-btn--primary m-btn--block"
          onClick={() => {
            const first = episodes.find((e) => e.playable) ?? episodes[0];
            if (first !== undefined) play(seriesId, first.episodeId, first.no);
          }}
        >
          <Icon name="play" size={15} /> 从第 1 集开始
        </button>
        <button type="button" className="m-btn m-btn--icon" data-on={following} onClick={toggleFollow} aria-label="追剧">
          <Icon name="bookmark" size={18} />
          <span>追剧</span>
        </button>
        <button type="button" className="m-btn m-btn--icon" data-on={favorited} onClick={toggleFav} aria-label="收藏">
          <Icon name="heart" size={18} />
          <span>收藏</span>
        </button>
      </div>

      {drama.intro !== '' && (
        <div className="m-detail__intro">
          <p data-expand={expand}>{drama.intro}</p>
          {drama.intro.length > 60 && (
            <button type="button" className="m-link" onClick={() => setExpand((v) => !v)}>
              {expand ? '收起' : '展开'}
            </button>
          )}
        </div>
      )}

      <div className="m-detail__section">
        <div className="m-section__head">
          <h3>选集</h3>
          <button type="button" className="m-link" onClick={() => setSelecting((v) => !v)}>
            {selecting ? '退出选择' : '选择下载'}
          </button>
        </div>
        <div className="m-eps">
          {episodes.map((ep) => (
            <button
              key={ep.episodeId}
              type="button"
              className="m-ep"
              data-active={picked.includes(ep.episodeId)}
              disabled={!ep.playable && !selecting}
              onClick={() => {
                if (selecting) {
                  setPicked((prev) => (prev.includes(ep.episodeId) ? prev.filter((id) => id !== ep.episodeId) : [...prev, ep.episodeId]));
                  return;
                }
                play(seriesId, ep.episodeId, ep.no);
              }}
            >
              {ep.no}
            </button>
          ))}
        </div>
        {selecting && (
          <div className="m-detail__selbar">
            <span>已选 {picked.length} 集</span>
            <button type="button" className="m-btn m-btn--primary m-btn--mini" disabled={picked.length === 0} onClick={queueDownload}>
              加入下载
            </button>
          </div>
        )}
      </div>

      {(series.data?.recommendations ?? []).length > 0 && (
        <div className="m-detail__section">
          <div className="m-section__head">
            <h3>猜你还想看</h3>
          </div>
          <div className="m-rail">
            {(series.data?.recommendations ?? []).map((item) => (
              <button type="button" className="m-card" key={item.seriesId} onClick={() => onOpen(item.seriesId)}>
                <span className="m-card__poster">
                  <img src={coverOf(item)} alt="" loading="lazy" />
                </span>
                <span className="m-card__title">{item.title}</span>
                <span className="m-card__meta">{item.episodeCount > 0 ? `${item.episodeCount} 集` : '短剧'}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {note !== '' && <div className="m-note m-note--live">{note}</div>}
    </div>
  );
}


