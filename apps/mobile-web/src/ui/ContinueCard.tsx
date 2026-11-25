import { useRef } from 'react';
import type { JSX } from 'react';
import { type ProgressEntry } from '../api.ts';
import { useTilt } from '../hooks/useTilt.ts';
import { playHash } from '../routes.ts';

/** 继续观看卡片：封面 + 进度条 + "第 N 集 · 已看 mm:ss"。 */
export function ContinueCard({ entry }: { entry: ProgressEntry }): JSX.Element {
  const ref = useRef<HTMLElement>(null);
  useTilt(ref, { maxX: 12, maxY: 14, scale: 1.03, lift: -5 });
  const cover =
    entry.cover !== '' ? `/api/img?url=${encodeURIComponent(entry.cover)}` : `/api/poster/${entry.seriesId}`;
  const pct =
    entry.durationSec > 0 ? Math.min(100, Math.round((entry.positionSec / entry.durationSec) * 100)) : 0;
  const mins = Math.floor(entry.positionSec / 60);

  return (
    <article
      ref={ref}
      className="drama-card continue-card"
      tabIndex={0}
      role="button"
      aria-label={`继续观看 ${entry.seriesTitle}`}
      onClick={() => {
        location.hash = playHash(entry.seriesId, entry.episodeId, entry.episodeNo);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          location.hash = playHash(entry.seriesId, entry.episodeId, entry.episodeNo);
        }
      }}
    >
      <div className="drama-card__poster">
        <img src={cover} alt="" loading="lazy" decoding="async" />
        <span className="tilt-glare" aria-hidden="true" />
        <span className="continue-card__badge">第 {entry.episodeNo} 集</span>
        <span className="continue-card__bar">
          <span style={{ width: `${pct}%` }} />
        </span>
      </div>
      <h3 className="drama-card__title">{entry.seriesTitle}</h3>
      <p className="drama-card__meta">已看 {mins > 0 ? `${mins} 分钟` : `${Math.floor(entry.positionSec)} 秒`}</p>
    </article>
  );
}
