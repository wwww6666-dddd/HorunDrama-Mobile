import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import { coverOf, type Drama } from '../api.ts';
import { useApp } from '../store.ts';
import { useTilt } from '../hooks/useTilt.ts';

interface Props {
  drama: Drama;
  rank?: number;
  score?: string;
}

/**
 * 影视卡片。
 *
 * 3D 倾斜 + 跟随光标柔光斑，逻辑统一在 useTilt：
 * - 透视/角度/缩放由 v2.css 的 `.drama-card` 消费；
 * - 光斑由 `.tilt-glare` 消费；
 * - 松手回正用速度+阻尼弹簧，有轻微回弹。
 */
export function DramaCard({ drama, rank, score }: Props): JSX.Element {
  const openDetail = useApp((s) => s.openDetail);
  const ref = useRef<HTMLElement>(null);
  useTilt(ref);
  // 搜索接口不给封面：退回按 seriesId 补取（后端带缓存）
  const cover = drama.cover !== '' ? coverOf(drama) : `/api/poster/${drama.seriesId}`;
  const meta = score !== '' && score !== undefined ? score : drama.heatText;

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;

    // 悬停 150ms 预取详情，点开时后端缓存已热
    let prefetchTimer: number | null = null;
    const prefetch = (): void => {
      prefetchTimer = window.setTimeout(() => {
        prefetchTimer = null;
        if (drama.seriesId === '') return;
        void fetch(`/api/series/${drama.seriesId}`).catch(() => undefined);
      }, 150);
    };
    const cancelPrefetch = (): void => {
      if (prefetchTimer !== null) window.clearTimeout(prefetchTimer);
      prefetchTimer = null;
    };

    el.addEventListener('pointerenter', prefetch);
    el.addEventListener('pointerleave', cancelPrefetch);
    return () => {
      cancelPrefetch();
      el.removeEventListener('pointerenter', prefetch);
      el.removeEventListener('pointerleave', cancelPrefetch);
    };
  }, [drama.seriesId]);

  const open = (): void => {
    openDetail(drama.seriesId);
  };

  return (
    <article
      ref={ref}
      className="drama-card"
      tabIndex={0}
      role="button"
      aria-label={drama.title}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
    >
      <div className="drama-card__poster">
        {cover !== '' ? (
          <img src={cover} alt="" loading="lazy" decoding="async" />
        ) : (
          <div className="drama-card__empty" />
        )}
        <span className="tilt-glare" aria-hidden="true" />
        {rank !== undefined && rank > 0 && <span className="drama-card__rank">{rank}</span>}
        {drama.finished && <span className="drama-card__badge">完结</span>}
      </div>
      <h3 className="drama-card__title">{drama.title}</h3>
      <p className="drama-card__meta">
        {drama.episodeCount > 0 ? `${drama.episodeCount} 集` : '短剧'}
        {meta !== '' && <span> · {meta}</span>}
      </p>
    </article>
  );
}
