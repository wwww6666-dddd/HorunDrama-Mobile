import type { JSX } from 'react';
import { api } from '../api.ts';
import { Page } from '../ui/Page.tsx';
import { ContinueCard } from '../ui/ContinueCard.tsx';
import { DramaCard } from '../ui/DramaCard.tsx';
import { StateBlock } from '../ui/StateBlock.tsx';
import { useAsync } from '../hooks/useAsync.ts';
import { useApp } from '../store.ts';

export function Theater(): JSX.Element {
  const home = useAsync((signal) => api.home(signal), []);
  const cont = useAsync((signal) => api.continueWatching(12, signal), []);
  const setView = useApp((s) => s.setView);

  return (
    <Page
      title="剧场"
      sub="继续观看 · 为你推荐 · 今日上新"
      actions={
        <>
          <button className="btn btn--ghost" onClick={() => setView('newreleases')}>
            新剧
          </button>
          <button className="btn btn--ghost" onClick={() => setView('category')}>
            分类
          </button>
        </>
      }
    >
      {cont.data !== null && cont.data.length > 0 && (
        <section className="section">
          <div className="section__head">
            <h2 className="section__title">继续观看</h2>
            <span className="section__count">{cont.data.length} 部</span>
          </div>
          <div className="rail">
            {cont.data.map((entry) => (
              <ContinueCard key={entry.seriesId} entry={entry} />
            ))}
          </div>
        </section>
      )}

      <StateBlock
        loading={home.loading}
        error={home.error}
        empty={home.data !== null && home.data.length === 0}
        onRetry={home.reload}
      >
        {home.data?.map((section) => (
          <section className="section" key={section.tabType}>
            <div className="section__head">
              <h2 className="section__title">{section.tabName}</h2>
              <span className="section__count">{section.items.length} 部</span>
            </div>
            <div className="rail">
              {section.items.map((d) => (
                <DramaCard key={`${section.tabType}-${d.seriesId}`} drama={d} />
              ))}
            </div>
          </section>
        ))}
      </StateBlock>
    </Page>
  );
}
