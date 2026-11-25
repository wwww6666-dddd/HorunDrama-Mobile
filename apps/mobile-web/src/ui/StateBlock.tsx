import type { JSX, ReactNode } from 'react';

export function StateBlock({
  loading,
  error,
  empty,
  emptyText,
  onRetry,
  children,
}: {
  loading: boolean;
  error: string | null;
  empty?: boolean;
  emptyText?: string;
  onRetry?: () => void;
  children?: ReactNode;
}): JSX.Element {
  if (loading) {
    return (
      <div className="card-grid" aria-busy="true">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="drama-card">
            <div className="drama-card__poster skeleton" />
            <div className="skeleton" style={{ height: 14, marginTop: 10, width: '80%' }} />
            <div className="skeleton" style={{ height: 12, marginTop: 8, width: '50%' }} />
          </div>
        ))}
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="state state--error">
        <p>{error}</p>
        {onRetry !== undefined && (
          <button className="btn" onClick={onRetry}>
            重试
          </button>
        )}
      </div>
    );
  }

  if (empty === true) {
    return <div className="state">{emptyText ?? '这里还没内容'}</div>;
  }

  return <>{children}</>;
}
