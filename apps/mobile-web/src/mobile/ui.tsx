/**
 * 手机端基础组件（自研，不复用桌面端 UI）。
 *
 * 设计参考（GitHub 成熟实现）：
 * - dpawlikowski/liquid-glass、nikdelvin/liquid-glass：用 feTurbulence + feDisplacementMap
 *   做背景折射，边缘用 screen 混合出一圈色散，替代"半透明灰块"；
 * - emilkowalski/skills 的 apple-design：弹层跟手、可打断、带速度判定，
 *   大表面强模糊、小控件弱模糊。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { JSX, ReactNode, PointerEvent as RPointerEvent } from 'react';

/* ------------------------------ 液态玻璃滤镜 ------------------------------ */

export function GlassDefs(): JSX.Element {
  return (
    <svg className="m-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <filter id="m-refract" x="-15%" y="-15%" width="130%" height="130%">
          <feTurbulence type="fractalNoise" baseFrequency="0.008 0.013" numOctaves="2" seed="11" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="9" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id="m-refract-soft" x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.012 0.018" numOctaves="1" seed="4" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="5" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
    </svg>
  );
}

/* -------------------------------- 图标 -------------------------------- */

const PATHS = {
  home: 'M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4v-5h-6v5H5a1 1 0 0 1-1-1z',
  play: 'M5 4.5v15l14-7.5z',
  rank: 'M5 19V9M12 19V5M19 19v-7',
  bookmark: 'M6 4h12v16l-6-4-6 4z',
  me: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20c1.2-4 4-6 7.5-6s6.3 2 7.5 6z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16.5 16.5 21 21',
  back: 'M15 5 8 12l7 7',
  chevron: 'M9 5l7 7-7 7',
  close: 'M6 6l12 12M18 6 6 18',
  heart: 'M12 20s-7-4.4-7-9.3A4 4 0 0 1 12 7a4 4 0 0 1 7 3.7c0 4.9-7 9.3-7 9.3z',
  download: 'M12 4v10M8 11l4 4 4-4M5 19h14',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2 1-2 3-2-1a6 6 0 0 1-2 1l-1 2h-4l-1-2a6 6 0 0 1-2-1l-2 1-2-3 2-1a6 6 0 0 1 0-2L3 9l2-3 2 1a6 6 0 0 1 2-1l1-2h4l1 2a6 6 0 0 1 2 1l2-1 2 3-2 1a6 6 0 0 1 0 2z',
  clock: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 8v4.5l3 2',
  share: 'M12 4v10M9 7l3-3 3 3M5 14v5h14v-5',
  check: 'M5 13l4 4 10-10',
  refresh: 'M4 12a8 8 0 0 1 13.7-5.6M20 12a8 8 0 0 1-13.7 5.6M18 3v4h-4M6 21v-4h4',
  tv: 'M4 6h16v11H4zM9 21h6',
  mute: 'M4 9h4l5-4v14l-5-4H4zM18 9l4 6M22 9l-4 6',
  filter: 'M4 7h16M7 12h10M10 17h4',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 22, className }: { name: IconName; size?: number; className?: string }): JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/* ------------------------------ 可拖拽弹层 ------------------------------ */

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** 全高抽屉（详情页用）；默认自动高度 */
  tall?: boolean;
  /** 固定在底部、不随内容滚动的操作区 */
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * 底部弹层：跟手拖动 + 松手速度判定 + 可打断。
 * 往下拖超过 96px，或者甩得够快，就关；否则弹回原位。
 */
export function Sheet({ open, onClose, title, tall = false, footer, children }: SheetProps): JSX.Element | null {
  const [drag, setDrag] = useState(0);
  const [closing, setClosing] = useState(false);
  const startY = useRef(0);
  const points = useRef<Array<{ y: number; t: number }>>([]);

  useEffect(() => {
    if (!open) {
      setDrag(0);
      setClosing(false);
      return;
    }
    // 打开时禁止背景滚动
    const root = document.documentElement;
    const prev = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  const finishClose = (): void => {
    setClosing(true);
    window.setTimeout(onClose, 220);
  };

  const down = (e: RPointerEvent<HTMLDivElement>): void => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    startY.current = e.clientY;
    points.current = [{ y: e.clientY, t: performance.now() }];
    setClosing(false);
  };

  const move = (e: RPointerEvent<HTMLDivElement>): void => {
    if (startY.current === 0) return;
    const dy = Math.max(0, e.clientY - startY.current);
    setDrag(dy);
    points.current.push({ y: e.clientY, t: performance.now() });
    if (points.current.length > 6) points.current.shift();
  };

  const up = (): void => {
    const first = points.current[0];
    const last = points.current[points.current.length - 1];
    const velocity = first !== undefined && last !== undefined && last.t !== first.t ? (last.y - first.y) / (last.t - first.t) : 0;
    startY.current = 0;
    if (drag > 96 || velocity > 0.55) {
      finishClose();
      return;
    }
    setDrag(0);
  };

  const sheet = (
    <div className="m-sheet-root" data-closing={closing}>
      <button className="m-sheet-mask" type="button" aria-label="关闭" onClick={finishClose} />
      <div
        className="m-sheet"
        data-tall={tall}
        data-dragging={drag > 0 && startY.current !== 0}
        style={{ transform: `translate3d(0, ${drag}px, 0)` }}
        role="dialog"
        aria-modal="true"
      >
        <div className="m-sheet__grab" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <span />
        </div>
        {title !== undefined && (
          <div className="m-sheet__head">
            <h2>{title}</h2>
            <button className="m-iconbtn" type="button" onClick={finishClose} aria-label="关闭">
              <Icon name="close" size={18} />
            </button>
          </div>
        )}
        {title === undefined && tall && (
          <button className="m-sheet__close m-iconbtn m-iconbtn--glass" type="button" onClick={finishClose} aria-label="关闭">
            <Icon name="close" size={18} />
          </button>
        )}
        <div className="m-sheet__body">{children}</div>
        {footer !== undefined && <div className="m-sheet__foot">{footer}</div>}
      </div>
    </div>
  );
  return createPortal(sheet, document.body);
}

/* -------------------------------- 控件 -------------------------------- */

export function Segmented<T extends string>({
  items,
  value,
  onChange,
}: {
  items: Array<{ value: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState({ x: 0, w: 0 });

  useLayoutEffect(() => {
    const measure = (): void => {
      const root = box.current;
      if (root === null) return;
      const active = root.querySelector<HTMLElement>('.m-seg__item[data-active="true"]');
      if (active === null) return;
      setThumb({ x: active.offsetLeft, w: active.offsetWidth });
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro !== null && box.current !== null) ro.observe(box.current);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [items.length, value]);

  return (
    <div className="m-seg" role="tablist" ref={box} data-ready={thumb.w > 0}>
      <span
        className="m-seg__thumb"
        aria-hidden="true"
        style={{ width: `${thumb.w}px`, transform: `translate3d(${thumb.x}px,0,0)` }}
      />
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={item.value === value}
          className="m-seg__item"
          data-active={item.value === value}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (next: boolean, event: React.MouseEvent<HTMLButtonElement>) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="m-switch"
      data-on={on}
      role="switch"
      aria-checked={on}
      onClick={(event) => onChange(!on, event)}
    >
      <span />
    </button>
  );
}

/** iOS 分组列表的一行：左标题、右内容/箭头 */
export function Row({
  label,
  hint,
  right,
  chevron = false,
  onClick,
}: {
  label: string;
  hint?: string;
  right?: ReactNode;
  chevron?: boolean;
  onClick?: () => void;
}): JSX.Element {
  const content = (
    <>
      <div className="m-row__main">
        <span className="m-row__label">{label}</span>
        {hint !== undefined && <span className="m-row__hint">{hint}</span>}
      </div>
      {right !== undefined && <div className="m-row__right">{right}</div>}
      {chevron && <span className="m-row__chev"><Icon name="chevron" size={17} /></span>}
    </>
  );
  if (onClick === undefined) return <div className="m-row">{content}</div>;
  return (
    <button type="button" className="m-row m-row--tap" onClick={onClick}>
      {content}
    </button>
  );
}

/** 分组容器：标题 + 圆角组 */
export function Group({ title, children }: { title?: string; children: ReactNode }): JSX.Element {
  return (
    <section className="m-group">
      {title !== undefined && <h3 className="m-group__title">{title}</h3>}
      <div className="m-group__body">{children}</div>
    </section>
  );
}

export function Loading({ text = '加载中' }: { text?: string }): JSX.Element {
  return (
    <div className="m-loading" role="status">
      <span className="m-spin" />
      {text}
    </div>
  );
}

/**
 * 首屏骨架屏：用和真实内容同尺寸的灰块占位，避免“转圈→内容突然出现”的跳变。
 * 注意只用于首屏加载；翻页/刷新继续用 Loading，避免每次刷新都闪一下骨架。
 */
export function Skeleton({
  rows = 4,
  variant = 'rows',
}: {
  rows?: number;
  variant?: 'rows' | 'grid' | 'home';
}): JSX.Element {
  if (variant === 'home') {
    return (
      <div className="m-skeleton" aria-hidden="true">
        <div className="m-sk-hero">
          <span className="m-sk-line" style={{ width: '28%' }} />
          <span className="m-sk-line m-sk-line--lg" style={{ width: '62%' }} />
          <span className="m-sk-line" style={{ width: '44%' }} />
          <span className="m-sk-pill" />
        </div>
        <div className="m-sk-cards">
          {Array.from({ length: 3 }, (_, i) => (
            <div className="m-sk-card" key={i}>
              <span className="m-sk-poster" />
              <span className="m-sk-line" style={{ width: '86%' }} />
              <span className="m-sk-line m-sk-line--sm" style={{ width: '46%' }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (variant === 'grid') {
    return (
      <div className="m-skeleton m-skeleton--grid" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <div className="m-sk-card" key={i}>
            <span className="m-sk-poster m-sk-poster--tall" />
            <span className="m-sk-line" style={{ width: '84%' }} />
            <span className="m-sk-line m-sk-line--sm" style={{ width: '40%' }} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="m-skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="m-sk-row" key={i}>
          <span className="m-sk-cover" />
          <span className="m-sk-row__main">
            <span className="m-sk-line" style={{ width: `${58 + (i % 3) * 12}%` }} />
            <span className="m-sk-line m-sk-line--sm" style={{ width: `${30 + (i % 2) * 10}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

export function Empty({ text, action }: { text: string; action?: ReactNode }): JSX.Element {
  return (
    <div className="m-empty">
      <p>{text}</p>
      {action}
    </div>
  );
}
