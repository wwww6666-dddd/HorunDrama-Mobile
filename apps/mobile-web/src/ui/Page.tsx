import type { ReactNode } from 'react';
import type { JSX } from 'react';

interface PageProps {
  title: string;
  sub?: string;
  actions?: ReactNode;
  /** 窄版：设置/表单这类一条一行、不需要铺满的页面 */
  narrow?: boolean;
  children: ReactNode;
}

export function Page({ title, sub, actions, narrow = false, children }: PageProps): JSX.Element {
  return (
    <section className={`page view-enter${narrow ? ' page--narrow' : ''}`}>
      <header className="page__head">
        <div>
          <h1 className="page__title">{title}</h1>
          {sub !== undefined && <p className="page__sub">{sub}</p>}
        </div>
        {actions !== undefined && <div className="page__actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}
