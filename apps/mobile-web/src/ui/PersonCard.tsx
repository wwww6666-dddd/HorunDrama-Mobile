import type { JSX } from 'react';

interface Props {
  rank: number;
  score: string;
  name: string;
  avatar: string;
  intro: string;
}

/** 演员榜：没有 3:4 剧照，用圆形头像 + 名次角标，保持和剧卡同一网格节奏。 */
export function PersonCard({ rank, score, name, avatar, intro }: Props): JSX.Element {
  const src = avatar === '' ? '' : `/api/img?url=${encodeURIComponent(avatar)}`;
  return (
    <article className="person-card" tabIndex={0} aria-label={name}>
      <div className="person-card__poster">
        {src !== '' ? <img src={src} alt="" loading="lazy" decoding="async" /> : <div className="drama-card__empty" />}
        {rank > 0 && <span className="drama-card__rank">{rank}</span>}
      </div>
      <h3 className="drama-card__title">{name}</h3>
      <p className="drama-card__meta">
        {score !== '' ? score : '演员'}
        {intro !== '' && <span> · {intro}</span>}
      </p>
    </article>
  );
}
