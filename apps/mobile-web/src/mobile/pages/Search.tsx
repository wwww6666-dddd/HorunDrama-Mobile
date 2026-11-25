import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { api, coverOf, type Drama, type Paged, type RankEntry } from '../../api.ts';
import { APP_AUTHOR, APP_VERSION, FEEDBACK_URL, GITHUB_URL, copyToClipboard, openExternalUrl } from '../../app-info.ts';
import { useAsync } from '../../hooks/useAsync.ts';
import { useApp } from '../../store.ts';
import { useNav } from '../nav.tsx';
import { Empty, Icon, Row, Skeleton } from '../ui.tsx';

/**
 * 搜索页（B5，对齐官方 7.4.5.32）。
 *
 * 官方结构从上到下：返回 + 搜索框 + 搜索 → 小果Ai/识剧/排行/上新/漫剧 胶囊 →
 * 搜索历史两列 → 猜你想搜 3 卡 → 热搜榜/预约榜 3 列大卡。
 * 官方第三个「热点话题榜」没有上游数据源，按开发文档口径只做两个 Tab。
 */

const HISTORY_KEY = 'horun-search-history-v1';
const HISTORY_MAX = 6;

const RANK_BOARDS = [
  { id: 'ranklist_hot_search_sc', label: '热搜榜' },
  { id: 'ranklist_subscribe', label: '预约榜' },
] as const;

type SeriesEntry = Extract<RankEntry, { kind: 'series' }>;

function isSeriesEntry(entry: RankEntry): entry is SeriesEntry {
  return entry.kind === 'series';
}

function readHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.trim() !== '').slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

function episodesText(drama: Drama): string {
  return drama.episodeCount > 0 ? `全${drama.episodeCount}集` : '短剧';
}

function rotate<T>(items: T[], offset: number, count: number): T[] {
  if (items.length === 0) return [];
  const out: T[] = [];
  for (let i = 0; i < Math.min(count, items.length); i += 1) {
    const item = items[(offset + i) % items.length];
    if (item !== undefined) out.push(item);
  }
  return out;
}

export function Search(): JSX.Element {
  const { back, go, openDetail } = useNav();
  const openShare = useApp((s) => s.openShare);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timer = useRef<number | null>(null);
  const noteTimer = useRef<number | null>(null);

  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [suggest, setSuggest] = useState<Array<{ text: string; keyword?: string }>>([]);
  const [history, setHistory] = useState<string[]>(readHistory);
  const [note, setNote] = useState('');
  const [guessOffset, setGuessOffset] = useState(0);
  const [board, setBoard] = useState<string>(RANK_BOARDS[0].id);

  const flash = (text: string): void => {
    setNote(text);
    if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(''), 2600);
  };

  useEffect(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    const value = query.trim();
    if (value === '') {
      setSuggest([]);
      return;
    }
    timer.current = window.setTimeout(() => {
      void api
        .suggest(value)
        .then((rows) => setSuggest(rows.slice(0, 8)))
        .catch(() => setSuggest([]));
    }, 180);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [query]);

  const result = useAsync<Paged | null>(async (signal) => {
    if (submitted === '') return null;
    return api.search(submitted, 1, '', signal);
  }, [submitted]);

  const hotRank = useAsync((signal) => api.rank('all', RANK_BOARDS[0].id, '', signal), []);
  const boardPage = useAsync((signal) => api.rank('all', board, '', signal), [board]);

  const remember = (value: string): void => {
    const q = value.trim();
    if (q === '') return;
    const next = [q, ...history.filter((item) => item !== q)].slice(0, HISTORY_MAX);
    setHistory(next);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      localStorage.setItem('horun-search-query', q);
    } catch {
      /* 本地存储被禁时只影响历史，不影响搜索 */
    }
  };

  const run = (value: string): void => {
    const q = value.trim();
    if (q === '') {
      inputRef.current?.focus();
      return;
    }
    remember(q);
    setQuery(q);
    setSubmitted(q);
    setSuggest([]);
    setNote('');
    inputRef.current?.blur();
  };

  const clearHistory = (): void => {
    setHistory([]);
    try {
      localStorage.removeItem(HISTORY_KEY);
      localStorage.removeItem('horun-search-query');
    } catch {
      /* ignore */
    }
    flash('搜索历史已清空');
  };

  const pickQuick = (kind: string): void => {
    if (kind === 'ai') {
      inputRef.current?.focus();
      flash('小果 AI 暂未接入，先用关键词搜');
      return;
    }
    if (kind === 'scan') {
      openShare(true);
      return;
    }
    if (kind === 'rank') {
      go('rank');
      return;
    }
    if (kind === 'new') {
      go('new');
      return;
    }
    go('category');
  };

  const items = result.data?.items ?? [];
  const hotSeries = (hotRank.data?.items ?? []).filter(isSeriesEntry);
  const guess = rotate(hotSeries, guessOffset, 3);
  const boardSeries = (boardPage.data?.items ?? []).filter(isSeriesEntry).slice(0, 9);
  const placeholder = history[0] ?? '搜剧名、演员、剧情关键词';

  return (
    <div className="m-searchpage">
      <header className="ms-head">
        <button type="button" className="ms-back" aria-label="返回" onClick={back}>
          <Icon name="back" size={22} />
        </button>
        <div className="ms-box">
          <Icon name="search" size={17} />
          <input
            ref={inputRef}
            type="search"
            value={query}
            placeholder={placeholder}
            enterKeyHint="search"
            aria-label="搜索"
            onChange={(event) => {
              setQuery(event.target.value);
              if (submitted !== '') setSubmitted('');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') run(query);
            }}
          />
          {query !== '' && (
            <button
              type="button"
              className="ms-clear"
              aria-label="清空"
              onClick={() => {
                setQuery('');
                setSubmitted('');
                setSuggest([]);
                inputRef.current?.focus();
              }}
            >
              <Icon name="close" size={15} />
            </button>
          )}
        </div>
        <button type="button" className="ms-go" onClick={() => run(query)}>
          搜索
        </button>
      </header>

      <div className="ms-quick" role="toolbar" aria-label="快捷入口">
        <button type="button" className="ms-qchip" data-kind="ai" onClick={() => pickQuick('ai')}>
          <span className="ms-qicon ms-qicon--ai">AI</span>
          小果Ai
        </button>
        <button type="button" className="ms-qchip" data-kind="scan" onClick={() => pickQuick('scan')}>
          <span className="ms-qicon ms-qicon--scan"><Icon name="search" size={13} /></span>
          识剧
        </button>
        <button type="button" className="ms-qchip" data-kind="rank" onClick={() => pickQuick('rank')}>
          <span className="ms-qicon ms-qicon--rank"><Icon name="rank" size={13} /></span>
          排行
        </button>
        <button type="button" className="ms-qchip" data-kind="new" onClick={() => pickQuick('new')}>
          <span className="ms-qicon ms-qicon--new"><Icon name="play" size={13} /></span>
          上新
        </button>
        <button type="button" className="ms-qchip" data-kind="comic" onClick={() => pickQuick('comic')}>
          <span className="ms-qicon ms-qicon--comic"><Icon name="bookmark" size={13} /></span>
          漫剧
        </button>
      </div>

      {note !== '' && <p className="ms-note" role="status">{note}</p>}

      {query.trim() !== '' && submitted === '' && suggest.length > 0 && (
        <div className="ms-suggest">
          {suggest.map((row) => (
            <button
              key={`${row.text}-${row.keyword ?? ''}`}
              type="button"
              className="ms-suggest__item"
              onClick={() => {
                const id = row.keyword ?? '';
                if (/^\d{6,25}$/.test(id)) {
                  remember(row.text);
                  setQuery(row.text);
                  setSubmitted('');
                  setSuggest([]);
                  openDetail(id);
                } else {
                  run(row.text);
                }
              }}
            >
              <Icon name="search" size={14} />
              <span>{row.text}</span>
            </button>
          ))}
        </div>
      )}

      {submitted !== '' ? (
        <section className="ms-results" aria-label="搜索结果">
          <div className="ms-results__head">
            <h2>搜索结果</h2>
            {!result.loading && result.error === null && <span>{items.length} 部</span>}
          </div>
          {result.loading && <Skeleton rows={3} />}
          {result.error !== null && <Empty text={result.error} />}
          {!result.loading && result.error === null && items.length === 0 && (
            <div className="ms-empty">
              <p>没有找到「{submitted}」</p>
              <button type="button" onClick={() => run('重生')}>搜「重生」试试</button>
            </div>
          )}
          {!result.loading &&
            result.error === null &&
            items.map((drama) => (
              <button
                type="button"
                className="ms-rrow"
                key={drama.seriesId}
                onClick={() => openDetail(drama.seriesId)}
              >
                <span className="ms-rrow__cover">
                  <img
                    src={drama.cover !== '' ? coverOf(drama) : `/api/poster/${drama.seriesId}`}
                    alt=""
                    loading="lazy"
                    decoding="async"
                  />
                </span>
                <span className="ms-rrow__main">
                  <span className="ms-rrow__title">{drama.title}</span>
                  <span className="ms-rrow__meta">
                    {[episodesText(drama), drama.finished ? '完结' : '', drama.heatText]
                      .filter((text) => text !== '')
                      .join(' · ')}
                  </span>
                  {drama.intro !== '' && <span className="ms-rrow__intro">{drama.intro}</span>}
                </span>
                <Icon name="chevron" size={16} />
              </button>
            ))}
        </section>
      ) : (
        <>
          {history.length > 0 && (
            <section className="ms-sec" aria-label="搜索历史">
              <div className="ms-sechead">
                <h2>搜索历史</h2>
                <button type="button" className="ms-iconbtn" aria-label="清空搜索历史" onClick={clearHistory}>
                  <Icon name="trash" size={20} />
                </button>
              </div>
              <div className="ms-history">
                {history.map((word) => (
                  <button type="button" className="ms-history__item" key={word} title={word} onClick={() => run(word)}>
                    {word}
                  </button>
                ))}
              </div>
            </section>
          )}

          {(guess.length > 0 || hotRank.loading) && (
            <section className="ms-sec" aria-label="猜你想搜">
              <div className="ms-sechead">
                <h2>猜你想搜</h2>
                <button
                  type="button"
                  className="ms-iconbtn"
                  aria-label="换一批"
                  onClick={() => {
                    setGuessOffset((offset) => offset + 3);
                  }}
                >
                  <Icon name="refresh" size={20} />
                </button>
              </div>
              {hotRank.loading && <Skeleton rows={2} />}
              {hotRank.error !== null && <p className="ms-dim">{hotRank.error}</p>}
              {hotSeries.length > 0 && (
                <div className="ms-guess">
                  {guess.map((entry) => (
                    <GuessCard key={entry.drama.seriesId} entry={entry} onOpen={openDetail} />
                  ))}
                </div>
              )}
            </section>
          )}

          <section className="ms-rankpanel" aria-label="榜单">
            <div className="ms-rtabs" role="tablist" aria-label="榜单分类">
              {RANK_BOARDS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={item.id === board}
                  className="ms-rtab"
                  data-active={item.id === board}
                  onClick={() => setBoard(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>

            {boardPage.loading && <Skeleton rows={3} />}
            {boardPage.error !== null && <Empty text={boardPage.error} />}
            {!boardPage.loading && boardPage.error === null && boardSeries.length === 0 && (
              <p className="ms-dim">榜单暂时没有数据</p>
            )}
            {!boardPage.loading && boardPage.error === null && boardSeries.length > 0 && (
              <div className="ms-rgrid">
                {boardSeries.map((entry, index) => (
                  <RankCard
                    key={entry.drama.seriesId}
                    entry={entry}
                    fallbackRank={index + 1}
                    showNew={board === 'ranklist_subscribe' || entry.drama.tags.includes('新剧')}
                    onOpen={openDetail}
                  />
                ))}
              </div>
            )}

            <button type="button" className="ms-rankmore" onClick={() => go('rank')}>
              查看完整榜单
              <Icon name="chevron" size={14} />
            </button>
          </section>
        </>
      )}
    </div>
  );
}

function GuessCard({ entry, onOpen }: { entry: SeriesEntry; onOpen: (id: string) => void }): JSX.Element {
  const heat = entry.score !== '' ? entry.score : entry.drama.heatText;
  return (
    <button type="button" className="ms-gcard" onClick={() => onOpen(entry.drama.seriesId)}>
      <span className="ms-gcard__poster">
        <img src={coverOf(entry.drama)} alt="" loading="lazy" decoding="async" />
        <span className="ms-heat">{heat !== '' ? heat : episodesText(entry.drama)}</span>
      </span>
      <span className="ms-gcard__title">{entry.drama.title}</span>
      <span className="ms-gcard__meta">
        {[episodesText(entry.drama), entry.drama.finished ? '完结' : ''].filter((text) => text !== '').join(' · ')}
      </span>
    </button>
  );
}

function RankCard({
  entry,
  fallbackRank,
  showNew,
  onOpen,
}: {
  entry: SeriesEntry;
  fallbackRank: number;
  showNew: boolean;
  onOpen: (id: string) => void;
}): JSX.Element {
  const rank = entry.rank > 0 ? entry.rank : fallbackRank;
  return (
    <button type="button" className="ms-rankcard" onClick={() => onOpen(entry.drama.seriesId)}>
      <span className="ms-rankposter">
        <img src={coverOf(entry.drama)} alt="" loading="lazy" decoding="async" />
        <span className="ms-rankno" data-top={rank <= 3}>{rank}</span>
        {showNew && <span className="ms-new">新剧</span>}
      </span>
      <span className="ms-rankcard__title">{entry.drama.title}</span>
      <span className="ms-rankcard__meta">
        {[entry.score, episodesText(entry.drama)].filter((text) => text !== '').join(' · ')}
      </span>
    </button>
  );
}

export function About(): JSX.Element {
  const [note, setNote] = useState('');
  return (
    <>
      <div className="m-about-hero">
        <span className="m-about-hero__mark">H</span>
        <div>
          <h2>HorunDrama 手机端</h2>
          <p>本地测试版 · 不上架、不分发</p>
        </div>
      </div>

      <div className="m-prose">
        <p>
          手机只负责显示和操作，真正的活儿都在你自己的电脑上：解析、解码、下载、签名、缓存。所以这部手机和电脑必须在同一个局域网里，电脑上的核心服务开着才能连上。
        </p>
        <p>
          界面上没有广告、没有推荐算法干预，只有剧场、推荐、榜单、追剧四件事。播放器沿用原来的内核，画质、倍速、弹幕、选集都在手机上重排过。
        </p>
      </div>

      <div className="m-group">
        <div className="m-group__body">
          <Row label="版本" right={<span className="m-row__value">{APP_VERSION}</span>} />
          <Row label="作者" right={<span className="m-row__value">{APP_AUTHOR}</span>} />
          <Row label="数据位置" hint="全部在这台电脑上" right={<span className="m-row__value">本地</span>} />
          <Row
            label="反馈（复制链接）"
            chevron
            onClick={() => {
              void copyToClipboard(FEEDBACK_URL).then(() => setNote('反馈链接已复制'));
            }}
          />
        </div>
      </div>

      {note !== '' && <div className="m-note m-note--live">{note}</div>}

      <p className="m-foot">
        这是一个自用工具：仅在本机与自己的手机之间传输内容，不提供公开下载、不做商业分发。
        <br />
        <button
          type="button"
          className="m-link"
          onClick={() => {
            void openExternalUrl(GITHUB_URL);
          }}
        >
          项目主页
        </button>
      </p>
    </>
  );
}
