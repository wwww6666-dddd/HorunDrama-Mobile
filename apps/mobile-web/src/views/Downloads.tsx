import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { api, type DownloadItem, type DownloadsPayload } from '../api.ts';
import { Page } from '../ui/Page.tsx';
import { StateBlock } from '../ui/StateBlock.tsx';
import { playHash } from '../routes.ts';

type Filter = 'all' | 'active' | 'done';

const STATUS_TEXT: Record<DownloadItem['status'], string> = {
  queued: '排队中',
  working: '下载中',
  ready: '已完成',
  failed: '失败',
  paused: '已暂停',
  canceled: '已取消',
};

function fmtBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function Downloads(): JSX.Element {
  const [data, setData] = useState<DownloadsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [busyId, setBusyId] = useState('');
  const [concurrency, setConcurrency] = useState(2);

  useEffect(() => {
    void api
      .settings()
      .then((s) => setConcurrency(s.downloadConcurrency))
      .catch(() => undefined);
  }, []);

  const changeConcurrency = async (next: number): Promise<void> => {
    setConcurrency(next);
    try {
      await api.saveSettings({ downloadConcurrency: next });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await api.downloads();
      setData(next);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeCount = (data?.summary.queued ?? 0) + (data?.summary.working ?? 0);
  // 有在跑的任务才轮询，避免空转
  useEffect(() => {
    if (activeCount <= 0) return;
    const timer = window.setInterval(() => void refresh(), 1200);
    return () => window.clearInterval(timer);
  }, [activeCount, refresh]);

  const items = useMemo(() => {
    const list = data?.items ?? [];
    if (filter === 'active') return list.filter((i) => i.status === 'queued' || i.status === 'working' || i.status === 'paused');
    if (filter === 'done') return list.filter((i) => i.status === 'ready');
    return list;
  }, [data, filter]);

  const act = async (action: 'pause' | 'resume' | 'retry' | 'cancel' | 'remove' | 'reveal', item: DownloadItem): Promise<void> => {
    if (action === 'remove' && !window.confirm(`删除「${item.seriesTitle} 第${item.episodeNo}集」并删除本地文件？`)) return;
    setBusyId(item.id);
    try {
      await api.downloadAction(action, item.id);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId('');
    }
  };

  return (
    <Page
      title="下载"
      sub="下载任务在电脑上执行，文件保存在电脑磁盘"
      actions={
        <div className="dl-actions">
          <label className="dl-concurrency" title="同时下载集数">
            同时下载
            <select value={concurrency} onChange={(e) => void changeConcurrency(Number(e.target.value))}>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n} 集
                </option>
              ))}
            </select>
          </label>
          <button className="btn dl-open-dir" onClick={() => void api.openDownloadDir().catch(() => undefined)}>
            打开下载目录
          </button>
        </div>
      }
    >
      <div className="dl-toolbar">
        <div className="dl-tabs" role="tablist" aria-label="下载筛选">
          {(
            [
              ['all', '全部'],
              ['active', '进行中'],
              ['done', '已完成'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={filter === key}
              className="dl-tab"
              data-active={filter === key}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="dl-summary">
          共 {data?.summary.total ?? 0} 个任务 · 已完成 {data?.summary.ready ?? 0} · 进行中 {activeCount} · 占用{' '}
          {fmtBytes(data?.summary.bytes ?? 0)}
        </p>
      </div>

      <StateBlock
        loading={loading}
        error={error}
        empty={(data?.items.length ?? 0) === 0}
        emptyText="还没有下载任务：在剧集详情页点「下载本剧」，或在播放页点下载按钮"
      >
        {items.length === 0 ? (
          <p className="dl-empty-filter">这个筛选下没有任务</p>
        ) : (
          <div className="dl-list">
            {items.map((item) => {
              const cover = item.cover !== '' ? `/api/img?url=${encodeURIComponent(item.cover)}` : '';
              const pct = Math.round(Math.max(0, Math.min(1, item.progress)) * 100);
              const busy = busyId === item.id;
              return (
                <article className="dl-row" key={item.id} data-status={item.status}>
                  <div className="dl-row__cover">{cover !== '' && <img src={cover} alt="" loading="lazy" />}</div>
                  <div className="dl-row__main">
                    <p className="dl-row__title">{item.seriesTitle}</p>
                    <p className="dl-row__sub">
                      第 {item.episodeNo} 集
                      {item.quality !== '' && ` · ${item.quality}`}
                      {item.bytes > 0 && ` · ${fmtBytes(item.bytes)}`}
                    </p>
                    <div className="dl-bar" data-state={item.status}>
                      <span style={{ width: `${item.status === 'ready' ? 100 : pct}%` }} />
                    </div>
                    <p className="dl-row__note">
                      <span className="dl-badge" data-status={item.status}>
                        {STATUS_TEXT[item.status]}
                      </span>
                      {item.status === 'failed'
                        ? item.error
                        : item.status === 'ready'
                          ? (item.file !== '' ? item.file : item.message)
                          : item.message}
                    </p>
                  </div>
                  <div className="dl-row__actions">
                    {item.status === 'ready' ? (
                      <>
                        <button
                          className="btn btn--ghost btn--sm"
                          onClick={() => {
                            location.hash = playHash(item.seriesId, item.episodeId, item.episodeNo);
                          }}
                        >
                          播放
                        </button>
                        <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void act('reveal', item)}>
                          定位
                        </button>
                      </>
                    ) : null}
                    {(item.status === 'working' || item.status === 'queued') && (
                      <>
                        <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void act('pause', item)}>
                          暂停
                        </button>
                        <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void act('cancel', item)}>
                          取消
                        </button>
                      </>
                    )}
                    {(item.status === 'paused' || item.status === 'canceled') && (
                      <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void act('resume', item)}>
                        继续
                      </button>
                    )}
                    {item.status === 'failed' && (
                      <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void act('retry', item)}>
                        重试
                      </button>
                    )}
                    <button className="btn btn--ghost btn--sm dl-danger" disabled={busy} onClick={() => void act('remove', item)}>
                      删除
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </StateBlock>
    </Page>
  );
}
