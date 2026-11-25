import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { View } from '../store.ts';
import { useApp } from '../store.ts';
import {
  IconCategory,
  IconDownload,
  IconFeed,
  IconLibrary,
  IconRank,
  IconSearch,
  IconSettings,
  IconSpark,
  IconTheater,
} from './icons.tsx';

const ICONS = {
  theater: IconTheater,
  feed: IconFeed,
  newreleases: IconSpark,
  rank: IconRank,
  category: IconCategory,
  library: IconLibrary,
  downloads: IconDownload,
  search: IconSearch,
  settings: IconSettings,
} as const;

/**
 * 手机端底部导航：5 格。
 *
 * 手机上一个拇指只够扫过 5 个格子，所以把「新剧」收进剧场页头的胶囊、
 * 「分类」收进剧场页头、「下载管理」收进追剧页头、「搜索」放到顶栏图标。
 * 选中态是一枚跟着手指走的液态药丸（拉长—收缩—回弹），不是硬切色块。
 */
const MOBILE_ROUTES: Array<{ view: View; label: string }> = [
  { view: 'feed', label: '推荐' },
  { view: 'theater', label: '剧场' },
  { view: 'rank', label: '榜单' },
  { view: 'library', label: '追剧' },
  { view: 'settings', label: '我的' },
];

export function Dock(): JSX.Element {
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const [hidden, setHidden] = useState(false);
  /** 推荐页是沉浸式看片，dock 浮在画面上挡内容：闲置自动收起 */
  const [idle, setIdle] = useState(false);
  /** 液态药丸的位置，按当前格子实测出来，宽度变化时才有"流过去"的观感 */
  const navRef = useRef<HTMLElement | null>(null);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);

  useEffect(() => {
    setHidden(false);
  }, [view]);

  // 量出当前格子，药丸跟着走（窗口尺寸变化、系统字体缩放都要重新量）
  useEffect(() => {
    const nav = navRef.current;
    if (nav === null) return;
    const measure = (): void => {
      const index = MOBILE_ROUTES.findIndex((r) => r.view === view);
      const item = nav.querySelectorAll<HTMLElement>('.dock__item')[index];
      if (item === undefined) {
        setPill(null);
        return;
      }
      setPill({ x: item.offsetLeft, w: item.offsetWidth });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [view]);

  useEffect(() => {
    // 只在触摸设备（真手机）上做「闲置收起」；鼠标环境的模拟机一直显示
    const touch = window.matchMedia('(pointer: coarse)').matches;
    if (view !== 'feed' || !touch) {
      setIdle(false);
      return;
    }
    let timer: number | null = null;
    const arm = (): void => {
      setIdle(false);
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), 2500);
    };
    arm();
    window.addEventListener('pointermove', arm, { passive: true });
    window.addEventListener('pointerdown', arm, { passive: true });
    window.addEventListener('wheel', arm, { passive: true });
    window.addEventListener('touchstart', arm, { passive: true });
    window.addEventListener('scroll', arm, { passive: true });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener('pointermove', arm);
      window.removeEventListener('pointerdown', arm);
      window.removeEventListener('wheel', arm);
      window.removeEventListener('touchstart', arm);
      window.removeEventListener('scroll', arm);
    };
  }, [view]);

  useEffect(() => {
    const main = document.querySelector<HTMLElement>('.app__main');
    if (main === null) return;
    let last = main.scrollTop;
    const onScroll = (): void => {
      const y = main.scrollTop;
      if (y <= 8) {
        setHidden(false);
      } else if (y > last + 6) {
        setHidden(true);
      } else if (y < last - 6) {
        setHidden(false);
      }
      last = y;
    };
    main.addEventListener('scroll', onScroll, { passive: true });
    return () => main.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <nav ref={navRef} className="dock" aria-label="主导航" data-hidden={hidden} data-idle={idle}>
      {pill !== null && (
        <span
          className="dock__pill"
          aria-hidden="true"
          style={{ width: `${pill.w}px`, transform: `translateX(${pill.x}px)` }}
        />
      )}
      {MOBILE_ROUTES.map((route) => {
        const Icon = ICONS[route.view];
        const active = route.view === view;
        return (
          <button
            key={route.view}
            type="button"
            className="dock__item"
            data-active={active}
            aria-current={active ? 'page' : undefined}
            onClick={() => setView(route.view)}
            title={route.label}
          >
            <Icon size={20} />
            <span>{route.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
