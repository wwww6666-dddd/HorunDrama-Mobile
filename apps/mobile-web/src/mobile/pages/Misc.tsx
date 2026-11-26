import { useState } from 'react';
import type { JSX } from 'react';
import { api, coverOf, type DownloadItem, type FilterRow } from '../../api.ts';
import { useAsync } from '../../hooks/useAsync.ts';
import { useNav } from '../nav.tsx';
import { Empty, Icon, Loading, Skeleton, Sheet } from '../ui.tsx';

/* ------------------------------ 新剧日历 ------------------------------ */

export function NewReleases(): JSX.Element {
  const { openDetail } = useNav();
  const [date, setDate] = useState('');
  const page = useAsync((signal) => api.newReleases(date, '', signal), [date]);
  const data = page.data;

  return (
    <>
      {data !== null && data.dates.length > 0 && (
        <div className="m-chips">
          {data.dates.slice(0, 10).map((d) => (
            <button key={d} type="button" className="m-chip" data-active={d === (date || data.date)} onClick={() => setDate(d)}>
              {/^\d{8}$/.test(d) ? `${d.slice(4, 6)}/${d.slice(6, 8)}` : d.slice(5)}
            </button>
          ))}
        </div>
      )}

      {page.loading && <Skeleton rows={5} />}
      {page.error !== null && <Empty text={page.error} action={<button className="m-btn" type="button" onClick={page.reload}>重试</button>} />}

      <div className="m-list">
        {(data?.items ?? []).map((item) => (
          <button type="button" className="m-lrow" key={item.seriesId} onClick={() => openDetail(item.seriesId)}>
            <span className="m-lrow__cover">
              <img src={item.cover !== '' ? `/api/img?url=${encodeURIComponent(item.cover)}` : `/api/poster/${item.seriesId}`} alt="" loading="lazy" />
              {item.online && <span className="m-lrow__live">上线</span>}
            </span>
            <div className="m-lrow__main">
              <p className="m-lrow__title">{item.title}</p>
              <p className="m-lrow__meta">
                {[item.publishAt !== '' ? item.publishAt.slice(5, 16).replace('T', ' ') : '待定', item.episodeCount > 0 ? `${item.episodeCount} 集` : '', item.heat]
                  .filter((t) => t !== '')
                  .join(' · ')}
              </p>
              {item.note !== '' && <p className="m-lrow__intro">{item.note}</p>}
            </div>
            <Icon name="chevron" size={17} />
          </button>
        ))}
      </div>

      {!page.loading && (data?.items.length ?? 0) === 0 && page.error === null && <Empty text="这一天没有新剧" />}
    </>
  );
}

/* ------------------------------ 分类筛选 ------------------------------ */

export function Category(): JSX.Element {
  const { openDetail } = useNav();
  const filters = useAsync((signal) => api.filters(signal), []);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [sheetOpen, setSheetOpen] = useState(false);
  const [group, setGroup] = useState('');
  const result = useAsync((signal) => api.category(selected, 1, signal), [JSON.stringify(selected)]);
  const rows = filters.data?.rows ?? [];

  const nameOf = (row: FilterRow, value: string): string =>
    row.options.find((option) => option.value === value)?.name ?? value;

  const active = rows.flatMap((row) =>
    (selected[row.key] ?? []).map((value) => ({
      key: row.key,
      value,
      label: `${row.name.replace(/^全部/, '')} · ${nameOf(row, value)}`,
    })),
  );
  const activeCount = active.length;

  const openSheet = (): void => {
    setDraft(selected);
    const first = rows.find((row) => (selected[row.key] ?? []).length > 0) ?? rows[0];
    setGroup(first?.key ?? '');
    setSheetOpen(true);
  };

  const toggleDraft = (row: FilterRow, value: string): void => {
    setDraft((prev) => {
      const current = prev[row.key] ?? [];
      return {
        ...prev,
        [row.key]: current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
      };
    });
  };

  const apply = (): void => {
    setSelected(draft);
    setSheetOpen(false);
  };

  const clear = (): void => {
    setSelected({});
    setDraft({});
    setSheetOpen(false);
  };

  const remove = (key: string, value: string): void => {
    setSelected((prev) => ({ ...prev, [key]: (prev[key] ?? []).filter((item) => item !== value) }));
  };

  return (
    <>
      <div className="m-quick" role="navigation" aria-label="筛选入口">
        <button
          className="m-quick__item m-filter-trigger"
          type="button"
          onClick={openSheet}
          disabled={filters.loading}
        >
          <Icon name="filter" size={15} />
          筛选
          {activeCount > 0 && <span className="m-filter-count">{activeCount}</span>}
        </button>
      </div>

      {activeCount > 0 && (
        <div className="m-activebar">
          <div className="m-activebar__scroll">
            {active.map((item) => (
              <button className="m-token" type="button" key={`${item.key}:${item.value}`} onClick={() => remove(item.key, item.value)}>
                <span>{item.label}</span>
                <Icon name="close" size={12} />
              </button>
            ))}
          </div>
          <button className="m-activebar__clear" type="button" onClick={clear}>
            清空
          </button>
        </div>
      )}

      {filters.loading && <Loading text="读取筛选项" />}

      {result.loading && <Loading text="筛选中" />}

      <div className="m-grid">
        {(result.data?.items ?? []).map((drama) => (
          <article className="m-gcard" key={drama.seriesId} onClick={() => openDetail(drama.seriesId)}>
            <div className="m-gcard__poster">
              <img src={drama.cover !== '' ? coverOf(drama) : `/api/poster/${drama.seriesId}`} alt="" loading="lazy" />
            </div>
            <p className="m-gcard__title">{drama.title}</p>
            <p className="m-gcard__meta">{drama.episodeCount > 0 ? `${drama.episodeCount} 集` : '短剧'}</p>
          </article>
        ))}
      </div>

      {!result.loading && (result.data?.items.length ?? 0) === 0 && result.error === null && (
        <Empty text={activeCount > 0 ? '这组条件没有剧，减一两个再试' : '还没有可筛的剧'} />
      )}

      <Sheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="筛选"
        tall
        footer={
          <div className="m-filter-foot">
            <button className="m-btn m-btn--ghost" type="button" onClick={() => setDraft({})}>
              重置
            </button>
            <button className="m-btn m-btn--primary m-btn--block" type="button" onClick={apply}>
              查看结果
            </button>
          </div>
        }
      >
        <div className="m-filter-sheet">
          <div className="m-ftabs">
            {rows.map((row) => {
              const picked = draft[row.key] ?? [];
              return (
                <button
                  key={row.key}
                  type="button"
                  className="m-ftab"
                  data-active={row.key === (rows.find((item) => item.key === group)?.key ?? rows[0]?.key)}
                  onClick={() => setGroup(row.key)}
                >
                  {row.name.replace(/^全部/, '')}
                  {picked.length > 0 && <span>{picked.length}</span>}
                </button>
              );
            })}
          </div>
          {(() => {
            const row = rows.find((item) => item.key === group) ?? rows[0];
            if (row === undefined) return <Empty text="暂无筛选项" />;
            const picked = draft[row.key] ?? [];
            return (
              <section className="m-fgroup" key={row.key}>
                <header>
                  <h3>{row.name}</h3>
                  <span>{picked.length > 0 ? `已选 ${picked.length}` : '不限'}</span>
                </header>
                <div className="m-fopt-grid">
                  {row.options.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className="m-fopt"
                      data-active={picked.includes(option.value)}
                      aria-pressed={picked.includes(option.value)}
                      onClick={() => toggleDraft(row, option.value)}
                    >
                      <span>{option.name}</span>
                      {picked.includes(option.value) && <Icon name="check" size={15} />}
                    </button>
                  ))}
                </div>
              </section>
            );
          })()}
        </div>
      </Sheet>
    </>
  );
}

/* ------------------------------ 下载管理 ------------------------------ */

const STATUS_TEXT: Record<DownloadItem['status'], string> = {
  queued: '排队中',
  working: '下载中',
  ready: '已完成',
  failed: '失败',
  paused: '已暂停',
  canceled: '已取消',
};

export function Downloads(): JSX.Element {
  const list = useAsync((signal) => api.downloads(signal), []);
  const [note, setNote] = useState('');
  const data = list.data;

  const act = (action: 'pause' | 'resume' | 'retry' | 'cancel', id: string): void => {
    void api
      .downloadAction(action, id)
      .then(() => list.reload())
      .catch((err: unknown) => setNote(`操作失败：${(err as Error).message}`));
  };

  return (
    <>
      <div className="m-quick" role="navigation" aria-label="下载操作">
        <button className="m-quick__item" type="button" onClick={list.reload}>
          <Icon name="refresh" size={16} /> 刷新
        </button>
      </div>
      <p className="m-caption">{data !== null ? `共 ${data.summary.total} 个任务 · 下载在本机运行` : '下载在本机运行'}</p>

      {list.loading && <Skeleton rows={3} />}
      {list.error !== null && <Empty text={list.error} />}

      {(data?.items ?? []).map((item) => (
        <article className="m-dl" key={item.id}>
          <span className="m-dl__cover">
            <img src={item.cover !== '' ? `/api/img?url=${encodeURIComponent(item.cover)}` : `/api/poster/${item.seriesId}`} alt="" loading="lazy" />
          </span>
          <div className="m-dl__main">
            <p className="m-dl__title">{item.seriesTitle}</p>
            <p className="m-dl__meta">
              第 {item.episodeNo} 集 · {item.quality} · {STATUS_TEXT[item.status]}
              {item.status === 'working' ? ` ${Math.round(item.progress)}%` : ''}
            </p>
            <div className="m-dl__bar">
              <span data-state={item.status} style={{ width: `${Math.max(3, Math.round(item.progress))}%` }} />
            </div>
            {item.message !== '' && item.status !== 'ready' && <p className="m-dl__note">{item.message}</p>}
          </div>
          <div className="m-dl__actions">
            {item.status === 'working' && (
              <button className="m-btn m-btn--mini" type="button" onClick={() => act('pause', item.id)}>暂停</button>
            )}
            {item.status === 'paused' && (
              <button className="m-btn m-btn--mini" type="button" onClick={() => act('resume', item.id)}>继续</button>
            )}
            {(item.status === 'failed' || item.status === 'canceled') && (
              <button className="m-btn m-btn--mini" type="button" onClick={() => act('retry', item.id)}>重试</button>
            )}
            {item.status !== 'ready' && (
              <button className="m-btn m-btn--mini m-btn--ghost" type="button" onClick={() => act('cancel', item.id)}>取消</button>
            )}
          </div>
        </article>
      ))}

      {!list.loading && (data?.items.length ?? 0) === 0 && <Empty text="还没有下载任务，在剧集详情里选几集下载" />}
      {note !== '' && <div className="m-note m-note--live">{note}</div>}
      <p className="m-foot">文件保存在本机 {data?.dir ?? '应用下载目录'}，打开 App 即可管理。</p>
    </>
  );
}


