import { useState } from 'react';
import type { JSX } from 'react';
import { api } from '../api.ts';
import { Page } from '../ui/Page.tsx';
import { DramaCard } from '../ui/DramaCard.tsx';
import { InfiniteSentinel } from '../ui/InfiniteSentinel.tsx';
import { StateBlock } from '../ui/StateBlock.tsx';
import { useAsync } from '../hooks/useAsync.ts';
import { usePaged } from '../hooks/usePaged.ts';

export function Category(): JSX.Element {
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});

  // 条件参与首屏重置：换一行就从头翻，不能接着上一个条件的游标
  const key = JSON.stringify(Object.entries(selections).sort());
  const filters = useAsync((signal) => api.filters(signal), []);
  const { items, loading, error, hasMore, moreLoading, loadMore, reload } = usePaged(
    [key],
    (page, signal) => api.category(selections, page, signal),
    { idOf: (d) => d.seriesId },
  );

  const toggle = (rowKey: string, value: string): void => {
    setSelections((prev) => {
      const current = prev[rowKey] ?? [];
      const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
      const out = { ...prev };
      if (next.length === 0) delete out[rowKey];
      else out[rowKey] = next;
      return out;
    });
  };

  const rows = filters.data?.rows ?? [];
  const selectedCount = Object.values(selections).reduce((n, v) => n + v.length, 0);

  return (
    <Page
      title="分类"
      sub={selectedCount > 0 ? `已选 ${selectedCount} 个条件` : '按题材、角色、年代、排序筛选'}
      actions={
        selectedCount > 0 ? (
          <button className="btn btn--ghost" onClick={() => setSelections({})}>
            清除条件
          </button>
        ) : undefined
      }
    >
      {rows.length > 0 && (
        <div className="filter-panel">
          {rows.map((row) => {
            const open = openRows[row.key] === true;
            return (
              <div className="filter-row" key={row.key} data-open={open}>
                <span className="filter-row__name">{row.name}</span>
                <div className="filter-row__chips">
                  {row.options.map((opt) => {
                    const on = (selections[row.key] ?? []).includes(opt.value);
                    return (
                      <button
                        key={opt.value}
                        className={`chip${on ? ' chip--on' : ''}`}
                        aria-pressed={on}
                        onClick={() => toggle(row.key, opt.value)}
                      >
                        {opt.name}
                      </button>
                    );
                  })}
                  {row.options.length > 12 && !open && (
                    <button className="chip" onClick={() => setOpenRows((p) => ({ ...p, [row.key]: true }))}>
                      展开
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <StateBlock
        loading={loading}
        error={error}
        empty={!loading && error === null && items.length === 0}
        onRetry={reload}
      >
        <div className="card-grid">
          {items.map((d) => (
            <DramaCard key={d.seriesId} drama={d} />
          ))}
        </div>
        <InfiniteSentinel onReach={loadMore} disabled={!hasMore || loading} />
        <p className="load-more__hint">
          {moreLoading ? '加载中…' : hasMore ? '继续下滑自动加载' : '没有更多了'}
        </p>
      </StateBlock>
    </Page>
  );
}
