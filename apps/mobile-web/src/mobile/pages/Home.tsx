import type { JSX } from 'react';
import { api, coverOf, type Drama, type ProgressEntry } from '../../api.ts';
import { useAsync } from '../../hooks/useAsync.ts';
import { PageTitle } from '../PageTitle.tsx';
import { useNav } from '../nav.tsx';
import { Empty, Icon, Skeleton } from '../ui.tsx';

function coverUrl(drama: Drama): string {
  return drama.cover !== '' ? coverOf(drama) : `/api/poster/${drama.seriesId}`;
}

function pct(positionSec: number, durationSec: number): number {
  if (durationSec <= 0) return 0;
  return Math.max(2, Math.min(100, Math.round((positionSec / durationSec) * 100)));
}

function Hero({ entry }: { entry: ProgressEntry }): JSX.Element {
  const { openDetail, play } = useNav();
  return (
    <article className="m-hero m-hero--split" onClick={() => openDetail(entry.seriesId)}>
      <div className="m-hero__bg" style={{ backgroundImage: `url(${entry.cover !== '' ? entry.cover : `/api/poster/${entry.seriesId}`})` }} />
      <img className="m-hero__poster" src={entry.cover !== '' ? entry.cover : `/api/poster/${entry.seriesId}`} alt="" />
      <div className="m-hero__glass">
        <span className="m-hero__eyebrow">
          <Icon name="clock" size={13} /> 继续观看
        </span>
        <h2>{entry.seriesTitle}</h2>
        <p className="m-hero__meta">
          上次看到 第 {entry.episodeNo} 集 · 已看 {pct(entry.positionSec, entry.durationSec)}%
        </p>
        <div className="m-hero__bar">
          <span style={{ width: `${pct(entry.positionSec, entry.durationSec)}%` }} />
        </div>
        <div className="m-hero__actions">
          <button
            type="button"
            className="m-btn m-btn--primary"
            onClick={(e) => {
              e.stopPropagation();
              play(entry.seriesId, entry.episodeId, entry.episodeNo);
            }}
          >
            <Icon name="play" size={15} /> 接着看
          </button>
          <span className="m-hero__hint">点封面看详情</span>
        </div>
      </div>
    </article>
  );
}

export function Home(): JSX.Element {
  const { go, openDetail } = useNav();
  const home = useAsync((signal) => api.home(signal), []);
  const cont = useAsync((signal) => api.continueWatching(8, signal), []);

  const sections = home.data ?? [];
  const hero = cont.data?.[0] ?? null;
  const first = sections.flatMap((s) => s.items)[0] ?? null;

  return (
    <>
      <PageTitle
        title="剧场"
        sub="继续看、今日上新、热播推荐"
        actions={
          <button className="m-iconbtn m-iconbtn--glass" type="button" aria-label="搜索" onClick={() => go('search')}>
            <Icon name="search" size={19} />
          </button>
        }
      />

      <div className="m-quick" role="navigation" aria-label="快捷入口">
        <button type="button" className="m-quick__item" onClick={() => go('new')}>
          <Icon name="tv" size={16} /> 新剧日历
        </button>
        <button type="button" className="m-quick__item" onClick={() => go('category')}>
          <Icon name="settings" size={16} /> 分类
        </button>
        <button type="button" className="m-quick__item" onClick={() => go('rank')}>
          <Icon name="rank" size={16} /> 榜单
        </button>
        <button type="button" className="m-quick__item" onClick={() => go('downloads')}>
          <Icon name="download" size={16} /> 下载
        </button>
      </div>

      {home.loading && hero === null && <Skeleton variant="home" />}
      {home.error !== null && <Empty text={home.error} />}

      {hero !== null && <Hero entry={hero} />}

      {hero === null && first !== null && (
        <article className="m-hero m-hero--split" onClick={() => openDetail(first.seriesId)}>
          <div className="m-hero__bg" style={{ backgroundImage: `url(${coverUrl(first)})` }} />
          <img className="m-hero__poster" src={coverUrl(first)} alt="" />
          <div className="m-hero__glass">
            <span className="m-hero__eyebrow">今日热播</span>
            <h2>{first.title}</h2>
            <p className="m-hero__meta">
              {first.episodeCount > 0 ? `共 ${first.episodeCount} 集` : first.heatText !== '' ? first.heatText : '今日上新'}
            </p>
            <div className="m-hero__actions">
              <span className="m-btn m-btn--primary">看看这部</span>
            </div>
          </div>
        </article>
      )}

      {sections.map((section) => (
        <section className="m-section" key={section.tabType}>
          <div className="m-section__head">
            <h2>{section.tabName}</h2>
            <span className="m-section__count">{section.items.length} 部</span>
          </div>
          <div className="m-rail">
            {section.items.map((drama) => (
              <button key={drama.seriesId} type="button" className="m-card" onClick={() => openDetail(drama.seriesId)}>
                <span className="m-card__poster">
                  <img src={coverUrl(drama)} alt="" loading="lazy" decoding="async" />
                  <span className="m-card__glare" aria-hidden="true" />
                </span>
                <span className="m-card__title">{drama.title}</span>
                <span className="m-card__meta">
                  {drama.episodeCount > 0 ? `${drama.episodeCount} 集` : '短剧'}
                  {drama.finished ? ' · 完结' : ''}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}

      {!home.loading && sections.length === 0 && <Empty text="暂时没有内容，稍后再试" />}
    </>
  );
}


