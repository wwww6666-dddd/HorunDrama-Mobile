import { useEffect, useState } from 'react';
import type { JSX } from 'react';

/**
 * 自绘窗口按钮（最小化 / 最大化 / 关闭）。
 *
 * 为什么不用系统遮罩：`titleBarOverlay` 会画一条固定颜色的实色带，
 * 既不跟随深浅色，又会压住顶栏右侧的登录按钮（这两条都是真实收到的反馈）。
 * 自绘后按钮就在我们自己的布局里，颜色吃主题变量，位置由 flex 决定。
 */
export function WindowControls(): JSX.Element | null {
  const bridge = window.yimu;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (bridge === undefined) return;
    void bridge.isMaximized?.().then((v) => {
      if (typeof v === 'boolean') setMaximized(v);
    });
    return bridge.onWindowState?.((state) => setMaximized(state.maximized === true));
  }, [bridge]);

  if (bridge === undefined) return null;

  return (
    <div className="win-controls" aria-label="窗口控制">
      <button type="button" title="最小化" aria-label="最小化" onClick={() => void bridge.minimize?.()}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 6h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        title={maximized ? '还原' : '最大化'}
        aria-label={maximized ? '还原' : '最大化'}
        onClick={() => void bridge.toggleMaximize?.()}
      >
        {maximized ? (
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <rect x="1.6" y="3.4" width="6.4" height="6.4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.1" />
            <path d="M4.2 3.2V2.4a1 1 0 0 1 1-1h4.4a1 1 0 0 1 1 1V7a1 1 0 0 1-1 1h-.9" fill="none" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <rect x="2" y="2" width="8" height="8" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="win-controls__close"
        title="关闭"
        aria-label="关闭"
        onClick={() => void bridge.close?.()}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.6 2.6l6.8 6.8M9.4 2.6l-6.8 6.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
