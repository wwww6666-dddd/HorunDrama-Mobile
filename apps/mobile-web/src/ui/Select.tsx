import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { createPortal } from 'react-dom';

export interface SelectOption {
  value: string;
  label: string;
}

interface Props {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  className?: string;
}

/** 弹层坐标（fixed，相对视口）；null = 还没量好（先藏在屏幕外量宽度） */
interface MenuPos {
  left: number;
  top?: number;
  bottom?: number;
}

const GAP = 6;
const EDGE = 8;

/**
 * 玻璃风下拉：替换原生 select，带过渡和点击外部关闭。
 *
 * **弹层必须 portal 到 body**：设置页的卡片（`.settings-block`）用了 `backdrop-filter`，
 * 它会给卡片建立层叠上下文 —— 卡片里子元素的 `z-index` 再高，也压不过**排在后面那张卡片**，
 * 表现就是下拉被下一张卡片盖住、选项看不全（2026-11-17 用户反馈"抽屉被卡片遮住"）。
 *
 * 定位是两段式：先以 `visibility:hidden` 渲染在屏幕外量真实宽高，再右对齐贴到按钮下方；
 * 下面放不下就向上展开（比"一律向下"稳），滚动/改窗口大小时重新量。
 */
export function Select({ value, options, onChange, ariaLabel, className }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = options.find((option) => option.value === value);

  const place = useCallback((): void => {
    const host = rootRef.current;
    const menu = menuRef.current;
    if (host === null || menu === null) return;
    const rect = host.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const maxLeft = Math.max(EDGE, window.innerWidth - width - EDGE);
    const left = Math.min(Math.max(EDGE, rect.right - width), maxLeft);
    const below = window.innerHeight - rect.bottom - GAP - EDGE;
    const above = rect.top - GAP - EDGE;
    const openUp = below < height && above > below;
    setPos(
      openUp
        ? { left, bottom: Math.max(EDGE, window.innerHeight - rect.top + GAP) }
        : { left, top: Math.max(EDGE, Math.min(rect.bottom + GAP, window.innerHeight - EDGE - height)) },
    );
  }, []);

  // 打开后：先量后定位，然后跟随滚动/窗口变化
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
    window.addEventListener('resize', place);
    // 捕获阶段才收得到内部滚动容器
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent): void => {
      const target = event.target as Node;
      // 弹层已 portal 到 body，不在 rootRef 里，两处都要判
      if (rootRef.current?.contains(target) === true) return;
      if (menuRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={`hselect${className !== undefined ? ` ${className}` : ''}`} ref={rootRef}>
      <button
        type="button"
        className="hselect__button"
        aria-label={ariaLabel ?? '选择'}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="hselect__value">{current?.label ?? value}</span>
        <span className="hselect__chevron" data-open={open}>
          ⌄
        </span>
      </button>
      {open &&
        createPortal(
          <div
            className="hselect__menu"
            role="listbox"
            ref={menuRef}
            data-ready={pos !== null}
            style={
              pos === null
                ? { left: -9999, top: -9999, visibility: 'hidden' }
                : { left: pos.left, top: pos.top, bottom: pos.bottom }
            }
          >
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                className="hselect__option"
                data-active={option.value === value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
