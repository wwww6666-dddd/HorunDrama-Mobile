import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { api } from '../../api.ts';
import type { DownloadItem, FavoriteEntry, FollowEntry, LikeEntry, ProgressEntry, ReservationEntry } from '../../api.ts';
import { useAsync } from '../../hooks/useAsync.ts';
import { useApp } from '../../store.ts';
import { useNav } from '../nav.tsx';
import { Icon, Sheet } from '../ui.tsx';
import { LoginSheet } from '../LoginSheet.tsx';

type MeTab = 'history' | 'fav' | 'likes' | 'reserve';
type MeFilter = 'all' | 'done' | 'todo';

interface MeCard {
  seriesId: string;
  title: string;
  cover: string;
  meta: string;
  badge?: string;
  episodeId?: string;
  episodeNo?: number;
  ratio?: number;
  updatedAt?: number;
  /** 搜索结果里标记来源：历史/收藏/点赞/预约 */
  source?: MeTab;
}

const TABS: Array<{ key: MeTab; label: string }> = [
  { key: 'history', label: '历史' },
  { key: 'fav', label: '收藏' },
  { key: 'likes', label: '点赞' },
  { key: 'reserve', label: '预约' },
];

const EMPTY_TEXT: Record<MeTab, string> = {
  history: '还没有观看记录',
  fav: '还没有收藏的剧',
  likes: '还没有点过赞',
  reserve: '还没有预约的剧',
};

const coverOf = (cover: string, seriesId: string): string => (cover !== '' ? cover : `/api/poster/${seriesId}`);

function countText(value: number): string {
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  return String(value);
}

function toCard(entry: ProgressEntry | FavoriteEntry | LikeEntry | FollowEntry | ReservationEntry, tab: MeTab): MeCard {
  if (tab === 'history') {
    const item = entry as ProgressEntry;
    const ratio = item.durationSec > 0 ? Math.min(1, item.positionSec / item.durationSec) : 0;
    return {
      seriesId: item.seriesId,
      title: item.seriesTitle,
      cover: coverOf(item.cover, item.seriesId),
      meta: `看到第 ${item.episodeNo} 集`,
      episodeId: item.episodeId,
      episodeNo: item.episodeNo,
      ratio,
      updatedAt: item.updatedAt,
    };
  }
  if (tab === 'fav' || tab === 'likes') {
    const item = entry as FavoriteEntry | LikeEntry;
    return {
      seriesId: item.seriesId,
      title: item.seriesTitle,
      cover: coverOf(item.cover, item.seriesId),
      meta: `${item.episodeCount} 集`,
      updatedAt: item.updatedAt,
    };
  }
  if (tab === 'reserve') {
    const item = entry as ReservationEntry;
    return {
      seriesId: item.seriesId,
      title: item.seriesTitle,
      cover: coverOf(item.cover, item.seriesId),
      meta: item.online ? `已上线 · ${item.episodeCount} 集` : `待上线 · ${item.episodeCount} 集`,
      badge: item.online ? '已上线' : '待播',
      updatedAt: item.updatedAt,
    };
  }
  const follow = entry as FollowEntry;
  return {
    seriesId: follow.seriesId,
    title: follow.seriesTitle,
    cover: coverOf(follow.cover, follow.seriesId),
    meta: `更到 ${follow.latestCount} 集`,
    badge: follow.hasNew ? '有新集' : undefined,
    updatedAt: follow.updatedAt,
  };
}

function Cards({ tab, filter }: { tab: MeTab; filter: MeFilter }): JSX.Element {
  const { data, error, loading, reload } = useAsync<MeCard[]>(async (signal) => {
    if (tab === 'history') {
      const items = await api.continueWatching(60, signal);
      return items.map((item) => ({ ...toCard(item, 'history'), source: 'history' as const }));
    }
    if (tab === 'fav') {
      const items = await api.favorites(signal);
      return items.map((item) => ({ ...toCard(item, 'fav'), source: 'fav' as const }));
    }
    if (tab === 'likes') {
      const items = await api.likes(signal);
      return items.map((item) => ({ ...toCard(item, 'likes'), source: 'likes' as const }));
    }
    const items = await api.reservations(signal);
    return items.map((item) => ({ ...toCard(item, 'reserve'), source: 'reserve' as const }));
  }, [tab]);

  const rows = useMemo(() => {
    const all = data ?? [];
    if (tab !== 'history' || filter === 'all') return all;
    const done = all.filter((item) => (item.ratio ?? 0) >= 0.95);
    return filter === 'done' ? done : all.filter((item) => (item.ratio ?? 0) < 0.95);
  }, [data, filter, tab]);

  if (loading) {
    return (
      <div className="mm-grid" aria-busy="true">
        {Array.from({ length: 6 }, (_, i) => (
          <div className="mm-sk" key={i}>
            <div className="mm-sk__poster" />
            <div className="mm-sk__line" />
            <div className="mm-sk__line mm-sk__line--short" />
          </div>
        ))}
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="mm-empty">
        <p>加载失败：{error}</p>
        <button type="button" onClick={reload}>
          重试
        </button>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="mm-empty">
        <Icon name={tab === 'history' ? 'clock' : tab === 'fav' ? 'heart' : tab === 'likes' ? 'heart' : 'bookmark'} size={28} />
        <p>{EMPTY_TEXT[tab]}</p>
      </div>
    );
  }

  return (
    <div className="mm-grid">
      {rows.map((row) => (
        <MeCardView key={row.seriesId} row={row} tab={tab} />
      ))}
    </div>
  );
}

function MeCardView({ row, tab }: { row: MeCard; tab: MeTab }): JSX.Element {
  const { openDetail, play } = useNav();
  return (
    <div
      className="mm-card"
      role="button"
      tabIndex={0}
      onClick={() => openDetail(row.seriesId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') openDetail(row.seriesId);
      }}
    >
      <div className="mm-poster">
        <img src={row.cover} alt="" loading="lazy" />
        {row.badge !== undefined && <span className="mm-badge">{row.badge}</span>}
        {tab === 'history' && row.episodeId !== undefined && row.episodeNo !== undefined && (
          <button
            type="button"
            className="mm-continue"
            aria-label="继续观看"
            onClick={(e) => {
              e.stopPropagation();
              play(row.seriesId, row.episodeId as string, row.episodeNo as number);
            }}
          >
            <Icon name="play" size={14} />
          </button>
        )}
      </div>
      <h3>{row.title}</h3>
      <p>{row.meta}</p>
    </div>
  );
}

function MeSearch({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const [query, setQuery] = useState('');
  const { data, loading, error } = useAsync<MeCard[]>(async (signal) => {
    const [history, fav, likes, reserve] = await Promise.all([
      api.continueWatching(120, signal),
      api.favorites(signal),
      api.likes(signal),
      api.reservations(signal),
    ]);
    return [
      ...history.map((item) => ({ ...toCard(item, 'history'), source: 'history' as const })),
      ...fav.map((item) => ({ ...toCard(item, 'fav'), source: 'fav' as const })),
      ...likes.map((item) => ({ ...toCard(item, 'likes'), source: 'likes' as const })),
      ...reserve.map((item) => ({ ...toCard(item, 'reserve'), source: 'reserve' as const })),
    ];
  }, []);

  const rows = useMemo(() => {
    const all = data ?? [];
    const keyword = query.trim().toLowerCase();
    if (keyword === '') return all;
    return all.filter((item) => item.title.toLowerCase().includes(keyword));
  }, [data, query]);

  return (
    <Sheet open={open} onClose={onClose} tall>
      <div className="mm-search">
        <div className="mm-search__bar">
          <Icon name="search" size={17} />
          <input
            autoFocus
            value={query}
            placeholder="搜索历史、收藏、点赞、预约的剧"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query !== '' && (
            <button type="button" aria-label="清空" onClick={() => setQuery('')}>
              ×
            </button>
          )}
        </div>
        <p className="mm-search__hint">只搜索本机记录，不请求云端；共 {data?.length ?? 0} 条</p>

        {loading && (data ?? []).length === 0 && <div className="mm-empty"><p>正在读取本地记录…</p></div>}
        {error !== null && <div className="mm-empty"><p>读取失败：{error}</p></div>}
        {!loading && rows.length === 0 && (
          <div className="mm-empty">
            <p>{query.trim() === '' ? '还没有任何观看、收藏、点赞或预约记录' : `没有找到「${query.trim()}」`}</p>
          </div>
        )}
        {rows.length > 0 && (
          <div className="mm-grid mm-search__grid">
            {rows.map((row) => (
              <div key={`${row.source}-${row.seriesId}`} className="mm-search__cell">
                <span className="mm-search__badge">
                  {row.source === 'history' ? '历史' : row.source === 'fav' ? '收藏' : row.source === 'likes' ? '点赞' : '预约'}
                </span>
                <MeCardView row={row} tab={row.source ?? 'history'} />
              </div>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  );
}

export function Me(): JSX.Element {
  const { account, refreshAccount, setLibraryTab } = useApp();
  const { go } = useNav();
  const [tab, setTab] = useState<MeTab>('history');
  const [filter, setFilter] = useState<MeFilter>('all');
  const [loginOpen, setLoginOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    void refreshAccount();
  }, [refreshAccount]);

  const stats = useAsync(async (signal) => {
    const [fav, follow, downloads, history] = await Promise.all([
      api.favorites(signal),
      api.follows(signal),
      api.downloads(signal),
      api.continueWatching(60, signal),
    ]);
    return {
      fav: fav.length,
      follow: follow.length,
      download: downloads.items.filter((item: DownloadItem) => item.status === 'ready').length,
      history: history.length,
    };
  }, [account !== null && account.loggedIn]);

  const loggedIn = account !== null && account.loggedIn;
  const nickname = loggedIn ? (account.nickname !== '' ? account.nickname : '已登录') : '未登录';
  const userId = loggedIn ? account.userId : '';
  const avatar = loggedIn ? account.avatar : '';

  const quick: Array<{ label: string; sub: string; onClick: () => void }> = [
    { label: '下载', sub: '离线缓存', onClick: () => go('downloads') },
    { label: '收藏', sub: '我的收藏', onClick: () => setTab('fav') },
    {
      label: '追更',
      sub: '有新集',
      onClick: () => {
        setLibraryTab('follow');
        go('library');
      },
    },
    { label: '预约', sub: '预约记录', onClick: () => setTab('reserve') },
    { label: '设置', sub: '播放与外观', onClick: () => go('settings') },
  ];

  return (
    <div className="mm-me">
      <section className="mm-hero">
        <div className="mm-hero__top">
          <button type="button" className="mm-moon" aria-label="外观设置" onClick={() => go('settings')}>
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.2 14.6A8.2 8.2 0 0 1 9.4 3.8a8.5 8.5 0 1 0 10.8 10.8z" />
            </svg>
          </button>
          <button type="button" className="mm-menu" aria-label="设置" onClick={() => go('settings')}>
            <span />
            <span />
            <span />
            <i />
          </button>
        </div>

        <div className="mm-profile">
          <div className={avatar !== '' ? 'mm-avatar' : 'mm-avatar mm-avatar--empty'}>
            {avatar !== '' ? <img src={avatar} alt="" /> : <span>{nickname.slice(0, 1)}</span>}
          </div>
          <div className="mm-info">
            <h1>{nickname}</h1>
            <p>{loggedIn ? `Horun 号：${userId}` : '登录后同步收藏、进度和追更'}</p>
          </div>
        </div>

        <div className="mm-stats">
          <button type="button" className="mm-stat" onClick={() => setTab('fav')}>
            <b>{stats.data === null ? '—' : countText(stats.data.fav)}</b>
            <span>收藏</span>
          </button>
          <button
            type="button"
            className="mm-stat"
            onClick={() => {
              setLibraryTab('follow');
              go('library');
            }}
          >
            <b>{stats.data === null ? '—' : countText(stats.data.follow)}</b>
            <span>追更</span>
          </button>
          <button type="button" className="mm-stat" onClick={() => go('downloads')}>
            <b>{stats.data === null ? '—' : countText(stats.data.download)}</b>
            <span>下载</span>
          </button>
          <button type="button" className="mm-edit" onClick={() => (loggedIn ? go('settings') : setLoginOpen(true))}>
            {loggedIn ? '编辑资料' : '登录'}
          </button>
        </div>
      </section>

      <div className="mm-quick">
        {quick.map((item) => (
          <button type="button" key={item.label} className="mm-quick__item" onClick={item.onClick}>
            <b>{item.label}</b>
            <span>{item.sub}</span>
          </button>
        ))}
      </div>

      <section className="mm-library">
        <div className="mm-tabs">
          {TABS.map((item) => (
            <button type="button" key={item.key} className="mm-tab" data-active={tab === item.key} onClick={() => setTab(item.key)}>
              {item.label}
            </button>
          ))}
          <button type="button" className="mm-tab-search" aria-label="搜索我的记录" onClick={() => setSearchOpen(true)}>
            <Icon name="search" size={19} />
          </button>
        </div>

        {tab === 'history' && (
          <div className="mm-chips">
            <button type="button" data-active={filter === 'all'} onClick={() => setFilter('all')}>
              全部
            </button>
            <button type="button" data-active={filter === 'done'} onClick={() => setFilter('done')}>
              已看完
            </button>
            <button type="button" data-active={filter === 'todo'} onClick={() => setFilter('todo')}>
              未看完
            </button>
            <span className="mm-chips__tools">
              <button type="button" onClick={() => setFilterOpen(true)}>
                筛选
              </button>
              <button type="button" onClick={() => go('settings')}>
                编辑
              </button>
            </span>
          </div>
        )}

        <Cards tab={tab} filter={filter} />
      </section>

      <Sheet open={filterOpen} onClose={() => setFilterOpen(false)} title="筛选">
        <div className="mm-filter">
          {(
            [
              ['all', '全部'],
              ['done', '已看完'],
              ['todo', '未看完'],
            ] as Array<[MeFilter, string]>
          ).map(([key, label]) => (
            <button
              type="button"
              key={key}
              data-active={filter === key}
              onClick={() => {
                setFilter(key);
                setFilterOpen(false);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </Sheet>

      <MeSearch open={searchOpen} onClose={() => setSearchOpen(false)} />

      <LoginSheet
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        onDone={() => {
          stats.reload();
        }}
      />
    </div>
  );
}
