/**
 * 图标：沿用旧版图形语义（剧场=播放方块、推荐=上下滑、榜单=奖杯、分类=宫格、
 * 追剧=书签、搜索=放大镜、设置=齿轮），统一 24×24 描边、currentColor。
 * 不引入图标库：只有 10 个，手写更可控，也不会被第三方风格带偏。
 */
import type { JSX, ReactNode } from 'react';

type IconProps = { size?: number; className?: string };

function Svg({ size = 20, className, children }: IconProps & { children: ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconTheater = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M10 9.5v5l4.5-2.5z" />
  </Svg>
);

export const IconFeed = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M12 4v16" />
    <path d="M8 8l4-4 4 4" />
    <path d="M8 16l4 4 4-4" />
  </Svg>
);

export const IconRank = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M7 4h10v5a5 5 0 0 1-10 0z" />
    <path d="M7 5H4v2a3 3 0 0 0 3 3" />
    <path d="M17 5h3v2a3 3 0 0 1-3 3" />
    <path d="M12 14v4" />
    <path d="M8 21h8" />
  </Svg>
);

export const IconCategory = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
  </Svg>
);

export const IconLibrary = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M6 3.5h9l3 3V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z" />
    <path d="M9 3.5V8h6" />
  </Svg>
);

export const IconDownload = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M12 4v10" />
    <path d="M8 10l4 4 4-4" />
    <path d="M5 19h14" />
  </Svg>
);

export const IconSpark = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M12 3.5l1.8 4.9 4.9 1.8-4.9 1.8-1.8 4.9-1.8-4.9-4.9-1.8 4.9-1.8z" />
    <path d="M18.5 15.5l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z" />
  </Svg>
);

export const IconSearch = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4 4" />
  </Svg>
);

export const IconSettings = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v2.2M12 19.3v2.2M4.2 12H2M22 12h-2.2M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />
  </Svg>
);

export const IconShare = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M8.5 12.5l7-3.4" />
    <path d="M8.5 11.5l7 3.4" />
    <circle cx="6" cy="12" r="2.6" />
    <circle cx="18" cy="7" r="2.6" />
    <circle cx="18" cy="17" r="2.6" />
  </Svg>
);

export const IconSun = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.6v2.4M12 19v2.4M2.6 12h2.4M19 12h2.4M5.4 5.4l1.7 1.7M16.9 16.9l1.7 1.7M18.6 5.4l-1.7 1.7M7.1 16.9l-1.7 1.7" />
  </Svg>
);

export const IconMoon = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
  </Svg>
);

/* ---------- 播放器 ---------- */

export const IconBack = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M14.5 5.5L8 12l6.5 6.5" />
  </Svg>
);

export const IconPrev = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M18 6.5v11L10 12z" />
    <path d="M6 6v12" />
  </Svg>
);

export const IconNext = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M6 6.5v11L14 12z" />
    <path d="M18 6v12" />
  </Svg>
);

export const IconPlay = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M8 5.5l10 6.5-10 6.5z" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconPause = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <rect x="7" y="5.5" width="3.4" height="13" rx="1.2" fill="currentColor" stroke="none" />
    <rect x="13.6" y="5.5" width="3.4" height="13" rx="1.2" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconFullscreenExit = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M9 4v5H4" />
    <path d="M15 4v5h5" />
    <path d="M9 20v-5H4" />
    <path d="M15 20v-5h5" />
  </Svg>
);
