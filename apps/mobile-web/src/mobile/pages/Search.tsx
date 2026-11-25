import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { api, coverOf, type Paged } from '../../api.ts';
import { APP_AUTHOR, APP_VERSION, FEEDBACK_URL, GITHUB_URL, copyToClipboard, openExternalUrl } from '../../app-info.ts';
import { useAsync } from '../../hooks/useAsync.ts';
import { PageTitle } from '../PageTitle.tsx';
import { useNav } from '../nav.tsx';
import { Empty, Icon, Row, Skeleton } from '../ui.tsx';

export function Search(): JSX.Element {
  const { openDetail } = useNav();
  const [query, setQuery] = useState(() => localStorage.getItem('horun-search-query') ?? '');
  const [submitted, setSubmitted] = useState('');
  const [suggest, setSuggest] = useState<Array<{ text: string; keyword?: string }>>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
    }, 200);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [query]);

  const result = useAsync<Paged | null>(async (signal) => {
    if (submitted === '') return null;
    return api.search(submitted, 1, '', signal);
  }, [submitted]);

  const run = (value: string): void => {
    const q = value.trim();
    if (q === '') return;
    localStorage.setItem('horun-search-query', q);
    setQuery(q);
    setSubmitted(q);
    setSuggest([]);
    inputRef.current?.blur();
  };

  const items = result.data?.items ?? [];
  const hot = useAsync((signal) => api.home(signal), []);
  const hotTitles = Array.from(new Set((hot.data ?? []).flatMap((section) => section.items.map((d) => d.title)))).slice(0, 10);

  return (
    <>
      <PageTitle title="搜索" sub="剧名、演员、一句话剧情" />

      <div className="m-searchbar">
        <Icon name="search" size={17} />
        <input
          ref={inputRef}
          type="search"
          value={query}
          placeholder="想看点什么都行"
          enterKeyHint="search"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') run(query);
          }}
        />
        {query !== '' && (
          <button
            type="button"
            className="m-searchbar__clear"
            aria-label="清空"
            onClick={() => {
              setQuery('');
              setSubmitted('');
              inputRef.current?.focus();
            }}
          >
            <Icon name="close" size={15} />
          </button>
        )}
        <button type="button" className="m-searchbar__go" onClick={() => run(query)}>
          搜索
        </button>
      </div>

      {suggest.length > 0 && submitted === '' && (        <div className="m-suggest">
          {suggest.map((row) => (
            <button
              key={`${row.text}-${row.keyword ?? ''}`}
              type="button"
              className="m-suggest__item"
              onClick={() => {
                const id = row.keyword ?? '';
                if (/^\d{6,25}$/.test(id)) {
                  setQuery(row.text);
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

      {result.loading && <Skeleton rows={4} />}
      {result.error !== null && <Empty text={result.error} />}

      {items.length > 0 && (
        <div className="m-list">
          {items.map((drama) => (
            <button type="button" className="m-lrow" key={drama.seriesId} onClick={() => openDetail(drama.seriesId)}>
              <span className="m-lrow__cover m-lrow__cover--wide">
                <img src={drama.cover !== '' ? coverOf(drama) : `/api/poster/${drama.seriesId}`} alt="" loading="lazy" decoding="async" />
              </span>
              <div className="m-lrow__main">
                <p className="m-lrow__title">{drama.title}</p>
                <p className="m-lrow__meta">
                  {[drama.episodeCount > 0 ? `${drama.episodeCount} 集` : '短剧', drama.finished ? '完结' : '', drama.heatText]
                    .filter((t) => t !== '')
                    .join(' · ')}
                </p>
                {drama.intro !== '' && <p className="m-lrow__intro">{drama.intro}</p>}
              </div>
              <Icon name="chevron" size={17} />
            </button>
          ))}
        </div>
      )}

      {!result.loading && submitted !== '' && items.length === 0 && result.error === null && <Empty text={`没有找到「${submitted}」`} />}
      {submitted === '' && suggest.length === 0 && (
        <>
          {hotTitles.length > 0 && (
            <section className="m-hot">
              <h3>热门剧名</h3>
              <div className="m-chips m-chips--wrap">
                {hotTitles.map((title) => (
                  <button key={title} type="button" className="m-chip m-chip--sm" onClick={() => run(title)}>
                    {title}
                  </button>
                ))}
              </div>
            </section>
          )}
          <p className="m-foot">搜不到就换个词：剧名、演员、剧情关键词都行</p>
        </>
      )}
    </>
  );
}

export function About(): JSX.Element {
  const [note, setNote] = useState('');
  return (
    <>
      <PageTitle title="关于" sub={`HorunDrama 手机端 · ${APP_VERSION}`} />

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


