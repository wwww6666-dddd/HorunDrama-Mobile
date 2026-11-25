import type { JSX, ReactNode } from 'react';

/** 大标题页头：随内容滚走，顶栏的紧凑标题由外壳负责 */
export function PageTitle({
  title,
  sub,
  actions,
}: {
  title: string;
  sub?: string;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <header className="m-title">
      <div className="m-title__row">
        <h1>{title}</h1>
        {actions !== undefined && <div className="m-title__actions">{actions}</div>}
      </div>
      {sub !== undefined && <p className="m-title__sub">{sub}</p>}
    </header>
  );
}
