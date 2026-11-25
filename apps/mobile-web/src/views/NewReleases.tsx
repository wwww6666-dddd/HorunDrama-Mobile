import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { api, type NewReleaseItem } from '../api.ts';
import { Page } from '../ui/Page.tsx';
import { StateBlock } from '../ui/StateBlock.tsx';
import { useApp } from '../store.ts';

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function dayOf(date: string): { week: string; md: string } {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(4, 6));
  const d = Number(date.slice(6, 8));
  const dt = new Date(y, m - 1, d);
  return { week: WEEK[dt.getDay()] ?? '', md: `${m}/${d}` };
}

export function NewReleases(): JSX.Element {
  const openDetail = useApp((s) => s.openDetail);
  const [selected, setSelected] = useState('');
  const [dates, setDates] = useState<string[]>([]);
  const [items, setItems] = useState<NewReleaseItem[]>([]);
  const [cursor, setCursor] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reserved, setReserved] = useState<Set<string>>(new Set());
  const [reserving, setReserving] = useState('');

  const loadReserved = useCallback(async (): Promise<void> => {
    try {
      const list = await api.reservations();
      setReserved(new Set(list.map((item) => item.seriesId)));
    } catch {
      /* 预约列表拿不到不影响日历 */
    }
  }, []);

  useEffect(() => {
    void loadReserved();
  }, [loadReserved]);

  const toggleReserve = async (item: NewReleaseItem): Promise<void> => {
    setReserving(item.seriesId);
    try {
      await api.setReservation({
        seriesId: item.seriesId,
        seriesTitle: item.title,
        cover: item.cover,
        episodeCount: item.episodeCount,
        reserve: !reserved.has(item.seriesId),
      });
      await loadReserved();
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setReserving('');
    }
  };

  const load = useCallback(async (date: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const page = await api.newReleases(date);
      setSelected(page.date);
      setDates(page.dates);
      setItems(page.items);
      setCursor(page.cursor);
      setHasMore(page.hasMore);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load('');
  }, [load]);

  const loadMore = async (): Promise<void> => {
    if (cursor === '') return;
    setMore(true);
    try {
      const page = await api.newReleases(selected, cursor);
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.seriesId));
        return [...prev, ...page.items.filter((i) => !seen.has(i.seriesId))];
      });
      setCursor(page.cursor);
      setHasMore(page.hasMore);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setMore(false);
    }
  };

  return (
    <Page title="新剧" sub="上新日历 · 每天更新，预约数来自上游">
      <StateBlock loading={loading} error={error} empty={!loading && items.length === 0} emptyText="这一天还没有新剧">
        {dates.length > 0 && (
          <div className="nr-dates" role="tablist" aria-label="日期">
            {dates.map((date) => {
              const info = dayOf(date);
              return (
                <button
                  key={date}
                  role="tab"
                  aria-selected={date === selected}
                  className="nr-date"
                  data-active={date === selected}
                  onClick={() => void load(date)}
                >
                  <span className="nr-date__week">{info.week}</span>
                  <span className="nr-date__md">{info.md}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="nr-list">
          {items.map((item) => {
            const cover = item.cover !== '' ? `/api/img?url=${encodeURIComponent(item.cover)}` : '';
            return (
              <article className="nr-row" key={item.seriesId} data-online={item.online}>
                <div className="nr-cover">
                  {cover !== '' && <img src={cover} alt="" loading="lazy" />}
                </div>
                <div className="nr-main">
                  <h3 className="nr-title">{item.title}</h3>
                  <p className="nr-meta">
                    {item.heat !== '' && <span className="nr-heat">{item.heat}</span>}
                    {item.episodeCount > 0 && <span>共 {item.episodeCount} 集</span>}
                    {item.categories.map((c) => (
                      <span className="chip" key={c}>
                        {c}
                      </span>
                    ))}
                    <span className="nr-status" data-online={item.online}>
                      {item.online ? '已上线' : '即将上线'}
                    </span>
                  </p>
                  {item.intro !== '' && <p className="nr-intro">{item.intro}</p>}
                  {item.note !== '' && <p className="nr-note">{item.note}</p>}
                </div>
                <div className="nr-actions">
                  <button className="btn" onClick={() => openDetail(item.seriesId)}>
                    详情
                  </button>
                  {!item.online && (
                    <button
                      className={`btn${reserved.has(item.seriesId) ? ' btn--primary' : ''}`}
                      disabled={reserving === item.seriesId}
                      onClick={() => void toggleReserve(item)}
                    >
                      {reserved.has(item.seriesId) ? '已预约' : '预约'}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        {hasMore && (
          <div className="nr-more">
            <button className="btn" disabled={more} onClick={() => void loadMore()}>
              {more ? '加载中…' : '加载更多'}
            </button>
          </div>
        )}
      </StateBlock>
    </Page>
  );
}
