import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { api, type FavoriteEntry, type FollowEntry, type LikeEntry, type ProgressEntry } from '../api.ts';
import { Page } from '../ui/Page.tsx';
import { StateBlock } from '../ui/StateBlock.tsx';
import { useAsync } from '../hooks/useAsync.ts';
import { useTilt } from '../hooks/useTilt.ts';
import { playHash } from '../routes.ts';
import { useApp } from '../store.ts';
import { IconSearch } from '../ui/icons.tsx';

type Tab = 'fav' | 'history' | 'likes' | 'follow';
type WatchFilter = 'all' | 'unfinished' | 'finished';
type FollowTab = 'series' | 'reserve';

function isFinished(entry: { positionSec: number; durationSec: number }): boolean {
  // saveProgress 在结尾 5 秒内把 position 归零，所以「有 duration 且 position≈0」= 已看完
  return entry.durationSec > 0 && entry.positionSec <= 0.1;
}

function LibCard({
  cover,
  title,
  sub,
  progress,
  actions,
  onOpen,
}: {
  cover: string;
  title: string;
  sub: string;
  progress?: number;
  actions: ReactNode;
  onOpen: () => void;
}): JSX.Element {
  const ref = useRef<HTMLElement>(null);
  useTilt(ref, { maxX: 10, maxY: 12, scale: 1.02, lift: -4 });

  return (
    <article ref={ref} className="lib2-card">
      <button className="lib2-card__poster" onClick={onOpen} title={title}>
        {cover !== '' ? <img src={cover} alt="" loading="lazy" /> : <span className="lib2-card__empty">无封面</span>}
        <span className="tilt-glare" aria-hidden="true" />
      </button>
      <div className="lib2-card__body">
        <p className="lib2-card__title">{title}</p>
        <p className="lib2-card__sub">{sub}</p>
        {progress !== undefined && (
          <div className="lib2-bar">
            <span style={{ width: `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%` }} />
          </div>
        )}
        <div className="lib2-card__actions">{actions}</div>
      </div>
    </article>
  );
}

export function Library(): JSX.Element {
  const cont = useAsync((signal) => api.continueWatching(100, signal), []);
  const fav = useAsync((signal) => api.favorites(signal), []);
  const likes = useAsync((signal) => api.likes(signal), []);
  const follows = useAsync((signal) => api.follows(signal), []);
  const reservations = useAsync((signal) => api.reservations(signal), []);
  const appSettings = useAsync((signal) => api.settings(signal), []);
  const openDetail = useApp((s) => s.openDetail);
  const setView = useApp((s) => s.setView);
  const initialTab = useApp((s) => s.libraryTab);

  const [tab, setTab] = useState<Tab>(initialTab);
  const [q, setQ] = useState('');
  const [watch, setWatch] = useState<WatchFilter>('all');
  const [followTab, setFollowTab] = useState<FollowTab>('series');
  const [syncNote, setSyncNote] = useState('');
  const [syncing, setSyncing] = useState(false);

  const doSync = async (force: boolean): Promise<void> => {
    setSyncing(true);
    try {
      const res = await api.accountSync(force);
      setSyncNote(res.message === '刚刚同步过' ? '账号数据已是最新（10 分钟内不重复拉取）' : res.message);
      if (res.history > 0 || res.favorites > 0 || res.follows > 0 || res.reservations > 0) {
        cont.reload();
        fav.reload();
        likes.reload();
        follows.reload();
        reservations.reload();
      }
    } catch (err) {
      setSyncNote(`同步失败：${(err as Error).message}`);
    } finally {
      setSyncing(false);
    }
  };

  // 打开页面就尝试同步一次（设置里关掉「自动同步」就不拉）
  useEffect(() => {
    if (appSettings.data === null) return;
    if (appSettings.data.autoSyncAccount === false) return;
    void doSync(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appSettings.data]);

  const showNewEpisodes = appSettings.data?.notifyNewEpisodes !== false;

  const progressOf = useMemo(() => {
    const map = new Map<string, ProgressEntry>();
    for (const entry of cont.data ?? []) map.set(entry.seriesId, entry);
    return map;
  }, [cont.data]);

  const match = (title: string): boolean => q.trim() === '' || title.toLowerCase().includes(q.trim().toLowerCase());

  const favorites = useMemo(() => {
    return (fav.data ?? []).filter((entry) => {
      if (!match(entry.seriesTitle)) return false;
      const p = progressOf.get(entry.seriesId);
      if (watch === 'all') return true;
      const finished = p !== undefined && isFinished(p);
      return watch === 'finished' ? finished : !finished;
    });
  }, [fav.data, q, watch, progressOf]);

  const history = useMemo(() => {
    return (cont.data ?? []).filter((entry) => {
      if (!match(entry.seriesTitle)) return false;
      if (watch === 'all') return true;
      const finished = isFinished(entry);
      return watch === 'finished' ? finished : !finished;
    });
  }, [cont.data, q, watch]);

  const likeList = useMemo(() => (likes.data ?? []).filter((entry) => match(entry.seriesTitle)), [likes.data, q]);
  const followList = useMemo(
    () => (follows.data ?? []).filter((entry) => match(entry.seriesTitle)),
    [follows.data, q],
  );
  const reservationList = useMemo(
    () => (reservations.data ?? []).filter((entry) => match(entry.seriesTitle)),
    [reservations.data, q],
  );

  const removeProgress = async (entry: ProgressEntry): Promise<void> => {
    await api.clearProgress(entry.seriesId);
    cont.reload();
  };

  const removeFavorite = async (entry: FavoriteEntry): Promise<void> => {
    await api.toggleFavorite({
      seriesId: entry.seriesId,
      seriesTitle: entry.seriesTitle,
      cover: entry.cover,
      episodeCount: entry.episodeCount,
    });
    fav.reload();
  };

  const removeLike = async (entry: LikeEntry): Promise<void> => {
    await api.toggleLike({
      seriesId: entry.seriesId,
      seriesTitle: entry.seriesTitle,
      cover: entry.cover,
      episodeCount: entry.episodeCount,
    });
    likes.reload();
  };

  const removeFollow = async (entry: FollowEntry): Promise<void> => {
    await api.toggleFollow({
      seriesId: entry.seriesId,
      seriesTitle: entry.seriesTitle,
      cover: entry.cover,
      episodeCount: entry.latestCount,
    });
    follows.reload();
  };

  const coverOf = (seriesId: string, cover: string): string =>
    cover !== '' ? `/api/img?url=${encodeURIComponent(cover)}` : `/api/poster/${seriesId}`;

  const tabCount = {
    fav: fav.data?.length ?? 0,
    history: cont.data?.length ?? 0,
    likes: likes.data?.length ?? 0,
    follow: follows.data?.length ?? 0,
  };
  const loading = fav.loading || cont.loading || likes.loading || follows.loading || reservations.loading;
  const error = fav.error ?? cont.error ?? likes.error ?? follows.error ?? reservations.error;

  const currentEmpty =
    tab === 'fav'
      ? favorites.length === 0
      : tab === 'history'
        ? history.length === 0
        : tab === 'likes'
          ? likeList.length === 0
          : followTab === 'series' && followList.length === 0;

  return (
    <Page
      title="追剧"
      sub="收藏 · 历史 · 点赞 · 追更"
      actions={
        <>
          <button className="btn btn--ghost" onClick={() => setView('downloads')}>
            下载管理
          </button>
          {tab === 'history' && (cont.data?.length ?? 0) > 0 && (
            <button
              className="btn btn--ghost"
              onClick={async () => {
                await api.clearProgress();
                cont.reload();
              }}
            >
              清空观看记录
            </button>
          )}
        </>
      }
    >
      <div className="lib2-toolbar">
        <div className="lib2-tabs" role="tablist" aria-label="追剧分类">
          {(
            [
              ['fav', '收藏'],
              ['history', '历史'],
              ['likes', '点赞'],
              ['follow', '追更'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              className="lib2-tab"
              data-active={tab === key}
              onClick={() => {
                setTab(key);
                setWatch('all');
              }}
            >
              {label}
              <span className="lib2-tab__count">{tabCount[key]}</span>
            </button>
          ))}
        </div>

        <div className="lib2-toolbar__right">
          <label className="lib2-search">
            <IconSearch size={15} />
            <input
              type="search"
              placeholder="搜索追剧"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="搜索追剧"
            />
          </label>
          <button className="btn btn--ghost btn--sm" disabled={syncing} onClick={() => void doSync(true)}>
            {syncing ? '同步中…' : '同步账号'}
          </button>
        </div>
      </div>

      {syncNote !== '' && <p className="lib2-sync-note">{syncNote}</p>}

      {tab === 'likes' && (
        <p className="lib2-sync-note">点赞会写回账号；但上游没有「我的点赞列表」接口，所以这里只显示本机点过的。</p>
      )}
      {tab === 'follow' && followTab === 'series' && (
        <p className="lib2-sync-note">账号追更列表会同步过来；在客户端新增的追更暂只写本机（写接口待接）。</p>
      )}

      {tab === 'follow' && (
        <div className="lib2-subtabs" role="tablist" aria-label="追更分类">
          <button
            className="lib2-filter"
            data-active={followTab === 'series'}
            onClick={() => setFollowTab('series')}
          >
            追更的剧
          </button>
          <button
            className="lib2-filter"
            data-active={followTab === 'reserve'}
            onClick={() => setFollowTab('reserve')}
          >
            预约
          </button>
        </div>
      )}

      {(tab === 'fav' || tab === 'history') && (
        <div className="lib2-filters" role="group" aria-label="观看状态">
          {(
            [
              ['all', '全部'],
              ['unfinished', '未看完'],
              ['finished', '已看完'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className="lib2-filter"
              data-active={watch === key}
              onClick={() => setWatch(key)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <StateBlock
        loading={loading}
        error={error}
        empty={currentEmpty}
        emptyText={
          tab === 'fav'
            ? '还没有收藏的剧'
            : tab === 'history'
              ? '还没有观看记录'
              : tab === 'likes'
                ? '还没有点赞的剧'
                : '还没有追更的剧：在详情页点「追更」'
        }
      >
        {tab === 'follow' && followTab === 'reserve' ? (
          <div className="lib2-reserve-wrap">
            {reservationList.length > 0 ? (
              <>
                <div className="lib2-grid">
                  {reservationList.map((entry) => (
                    <LibCard
                      key={entry.seriesId}
                      cover={coverOf(entry.seriesId, entry.cover)}
                      title={entry.seriesTitle}
                      sub={`${entry.online ? '已上线' : '待上线'}${
                        entry.episodeCount > 0 ? ` · 共 ${entry.episodeCount} 集` : ''
                      }`}
                      onOpen={() => openDetail(entry.seriesId)}
                      actions={
                        <button className="btn btn--ghost btn--sm" onClick={() => openDetail(entry.seriesId)}>
                          详情
                        </button>
                      }
                    />
                  ))}
                </div>
                <p className="lib2-sync-note">预约记录会写回账号，本机也保留一份。</p>
              </>
            ) : (
              <div className="lib2-reserve">
                <p className="lib2-reserve__title">还没有预约</p>
                <p className="lib2-reserve__hint">
                  在「新剧」的上新日历里，对即将上线的剧点「预约」即可；登录后会同步写到账号。
                </p>
                <button className="btn btn--primary" onClick={() => setView('newreleases')}>
                  去「新剧」
                </button>
              </div>
            )}
          </div>
        ) : (
        <div className="lib2-grid">
          {tab === 'fav' &&
            favorites.map((entry) => {
              const p = progressOf.get(entry.seriesId);
              return (
                <LibCard
                  key={entry.seriesId}
                  cover={coverOf(entry.seriesId, entry.cover)}
                  title={entry.seriesTitle}
                  sub={entry.episodeCount > 0 ? `共 ${entry.episodeCount} 集` : '短剧'}
                  progress={p !== undefined && p.durationSec > 0 ? p.positionSec / p.durationSec : undefined}
                  onOpen={() => openDetail(entry.seriesId)}
                  actions={
                    <>
                      <button className="btn btn--ghost btn--sm" onClick={() => openDetail(entry.seriesId)}>
                        详情
                      </button>
                      <button className="btn btn--ghost btn--sm" onClick={() => void removeFavorite(entry)}>
                        移除
                      </button>
                    </>
                  }
                />
              );
            })}

          {tab === 'history' &&
            history.map((entry) => (
              <LibCard
                key={entry.seriesId}
                cover={coverOf(entry.seriesId, entry.cover)}
                title={entry.seriesTitle}
                sub={`第 ${entry.episodeNo} 集${
                  entry.durationSec > 0 ? ` · 已看 ${Math.round((entry.positionSec / entry.durationSec) * 100)}%` : ''
                }`}
                progress={entry.durationSec > 0 ? entry.positionSec / entry.durationSec : undefined}
                onOpen={() => {
                  location.hash = playHash(entry.seriesId, entry.episodeId, entry.episodeNo);
                }}
                actions={
                  <>
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() => {
                        location.hash = playHash(entry.seriesId, entry.episodeId, entry.episodeNo);
                      }}
                    >
                      继续播放
                    </button>
                    <button className="btn btn--ghost btn--sm" onClick={() => void removeProgress(entry)}>
                      删除
                    </button>
                  </>
                }
              />
            ))}

          {tab === 'likes' &&
            likeList.map((entry) => (
              <LibCard
                key={entry.seriesId}
                cover={coverOf(entry.seriesId, entry.cover)}
                title={entry.seriesTitle}
                sub={entry.episodeCount > 0 ? `共 ${entry.episodeCount} 集` : '短剧'}
                onOpen={() => openDetail(entry.seriesId)}
                actions={
                  <>
                    <button className="btn btn--ghost btn--sm" onClick={() => openDetail(entry.seriesId)}>
                      详情
                    </button>
                    <button className="btn btn--ghost btn--sm" onClick={() => void removeLike(entry)}>
                      取消点赞
                    </button>
                  </>
                }
              />
            ))}
          {tab === 'follow' &&
            followTab === 'series' &&
            followList.map((entry) => (
              <LibCard
                key={entry.seriesId}
                cover={coverOf(entry.seriesId, entry.cover)}
                title={entry.seriesTitle}
                sub={`更新至 ${entry.latestCount} 集${
                  showNewEpisodes && entry.hasNew ? ' · 有新集' : ''
                }`}
                onOpen={() => openDetail(entry.seriesId)}
                actions={
                  <>
                    <button className="btn btn--ghost btn--sm" onClick={() => openDetail(entry.seriesId)}>
                      详情
                    </button>
                    <button className="btn btn--ghost btn--sm" onClick={() => void removeFollow(entry)}>
                      取消追更
                    </button>
                  </>
                }
              />
            ))}
        </div>
        )}
      </StateBlock>
    </Page>
  );
}
