import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { api } from '../api.ts';
import { useApp } from '../store.ts';
import { Page } from '../ui/Page.tsx';
import { DramaCard } from '../ui/DramaCard.tsx';
import { InfiniteSentinel } from '../ui/InfiniteSentinel.tsx';
import { StateBlock } from '../ui/StateBlock.tsx';
import { usePaged } from '../hooks/usePaged.ts';
import { IconSearch } from '../ui/icons.tsx';

const HISTORY_KEY = 'horun-search-history';

function takeInitialQuery(): string {
  try {
    const q = localStorage.getItem('horun-search-query') ?? '';
    if (q !== '') localStorage.removeItem('horun-search-query');
    return q;
  } catch {
    return '';
  }
}

export function Search(): JSX.Element {
  const initial = useRef(takeInitialQuery());
  const [input, setInput] = useState(initial.current);
  const [query, setQuery] = useState(initial.current);
  const [suggestions, setSuggestions] = useState<Array<{ text: string; keyword?: string }>>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const suggestTimer = useRef<number | null>(null);
  const openDetail = useApp((s) => s.openDetail);
  const [history, setHistory] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      return raw === null ? [] : (JSON.parse(raw) as string[]);
    } catch {
      return [];
    }
  });

  const { items, loading, error, hasMore, moreLoading, loadMore, reload } = usePaged(
    [query],
    (page, signal) => api.search(query, page, '', signal),
    { idOf: (d) => d.seriesId },
  );

  const submit = (value: string): void => {
    const q = value.trim();
    if (q === '') return;
    setQuery(q);
    setInput(q);
    setHistory((prev) => {
      const next = [q, ...prev.filter((x) => x !== q)].slice(0, 8);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  };

  const changeInput = (value: string): void => {
    setInput(value);
    if (suggestTimer.current !== null) window.clearTimeout(suggestTimer.current);
    if (value.trim() === '') {
      setSuggestions([]);
      setSuggestOpen(false);
      return;
    }
    suggestTimer.current = window.setTimeout(() => {
      void api
        .suggest(value.trim())
        .then((rows) => {
          setSuggestions(rows);
          setSuggestOpen(rows.length > 0);
        })
        .catch(() => {
          setSuggestions([]);
          setSuggestOpen(false);
        });
    }, 180);
  };

  const pickSuggestion = (row: { text: string; keyword?: string }): void => {
    const id = row.keyword ?? '';
    setSuggestOpen(false);
    if (/^\d{6,25}$/.test(id)) {
      openDetail(id);
      return;
    }
    submit(row.text);
  };

  // 关键词清空时不要留上一轮的状态
  useEffect(() => {
    if (query === '') setInput('');
  }, [query]);

  return (
    <Page title="搜索" sub={query === '' ? '剧名、演员、关键词都能搜' : `“${query}” 的结果`}>
      <div className="search-page-field">
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
        >
          <IconSearch size={17} />
          <input
            type="search"
            value={input}
            placeholder="输入关键词后回车"
            aria-label="搜索"
            onChange={(e) => changeInput(e.target.value)}
            onFocus={() => {
              if (suggestions.length > 0) setSuggestOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setSuggestOpen(false);
            }}
          />
          <button className="btn btn--primary" type="submit">
            搜索
          </button>
        </form>
        {suggestOpen && (
          <div className="search-suggest" role="listbox">
            {suggestions.map((row) => (
              <button
                key={`${row.text}-${row.keyword ?? ''}`}
                className="search-suggest__item"
                type="button"
                onClick={() => pickSuggestion(row)}
              >
                <IconSearch size={14} />
                <span>{row.text}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {query === '' && history.length > 0 && (
        <div className="section">
          <div className="section__head">
            <h2 className="section__title">最近搜索</h2>
            <button
              className="btn btn--ghost"
              onClick={() => {
                localStorage.removeItem(HISTORY_KEY);
                setHistory([]);
              }}
            >
              清空
            </button>
          </div>
          <div className="board-tabs">
            {history.map((h) => (
              <button key={h} className="chip" onClick={() => submit(h)}>
                {h}
              </button>
            ))}
          </div>
        </div>
      )}

      {query !== '' && (
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
      )}
    </Page>
  );
}
