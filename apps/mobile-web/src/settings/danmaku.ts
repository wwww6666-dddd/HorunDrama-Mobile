/**
 * 弹幕外观偏好（纯前端偏好，存 localStorage）。
 *
 * 为什么放本地而不是核心 settings.json：这些是"这台机器的观感"，
 * 换机器本来就该重新调；而且播放页要能同步读到，走本地零延迟。
 */
export type DanmakuBackground = 'none' | 'soft';
export type DanmakuSize = 'sm' | 'md' | 'lg';

export interface DanmakuPrefs {
  enabled: boolean;
  background: DanmakuBackground;
  /** 弹幕占屏比例：0.3 / 0.45 / 0.6 / 0.8 */
  coverage: number;
  size: DanmakuSize;
  /** 文字不透明度：0.3~1，播放器设置面板可调 */
  opacity: number;
  /** 是否加粗：默认 true，和参考播放器一致 */
  bold: boolean;
  /** 文字颜色：预设色值，默认白色 */
  color: string;
}

const KEY = 'horun-danmaku-prefs';
const LEGACY_KEY = 'horun-danmaku';

export const COVERAGE_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0.3, label: '30%' },
  { value: 0.45, label: '45%' },
  { value: 0.6, label: '60%' },
  { value: 0.8, label: '80%' },
];

export const SIZE_OPTIONS: Array<{ value: DanmakuSize; label: string }> = [
  { value: 'sm', label: '小' },
  { value: 'md', label: '中' },
  { value: 'lg', label: '大' },
];

export const DANMAKU_COLORS: Array<{ value: string; label: string }> = [
  { value: '#ffffff', label: '白' },
  { value: '#ffe14d', label: '黄' },
  { value: '#7fe7ff', label: '青' },
  { value: '#ff9ecf', label: '粉' },
  { value: '#9dff8a', label: '绿' },
  { value: '#ffb27a', label: '橙' },
];

const DEFAULTS: DanmakuPrefs = {
  enabled: true,
  // 默认纯透明：胶囊底会把画面糊住
  background: 'none',
  coverage: 0.45,
  size: 'md',
  opacity: 1,
  bold: true,
  color: '#ffffff',
};

export function readDanmakuPrefs(): DanmakuPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<DanmakuPrefs>;
      return {
        enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULTS.enabled,
        background: parsed.background === 'soft' ? 'soft' : 'none',
        coverage:
          typeof parsed.coverage === 'number' && parsed.coverage >= 0.2 && parsed.coverage <= 0.9
            ? parsed.coverage
            : DEFAULTS.coverage,
        size: parsed.size === 'sm' || parsed.size === 'lg' ? parsed.size : 'md',
        opacity:
          typeof parsed.opacity === 'number' && parsed.opacity >= 0.2 && parsed.opacity <= 1
            ? parsed.opacity
            : DEFAULTS.opacity,
        bold: typeof parsed.bold === 'boolean' ? parsed.bold : DEFAULTS.bold,
        color: typeof parsed.color === 'string' && /^#[0-9a-f]{6}$/i.test(parsed.color) ? parsed.color : DEFAULTS.color,
      };
    }
    // 兼容旧开关
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy !== null) return { ...DEFAULTS, enabled: legacy !== '0' };
  } catch {
    /* 破 JSON 就用默认 */
  }
  return DEFAULTS;
}

export function writeDanmakuPrefs(patch: Partial<DanmakuPrefs>): DanmakuPrefs {
  const next = { ...readDanmakuPrefs(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 存储不可用就只在内存里生效 */
  }
  return next;
}

export function danmakuFontSize(size: DanmakuSize): number {
  if (size === 'sm') return 14;
  if (size === 'lg') return 21;
  return 17;
}

/** 占屏比例 → 轨道数：一屏最多 11 条，太少会撞、太多会糊 */
export function lanesFor(coverage: number): number {
  return Math.max(3, Math.min(12, Math.round(coverage / 0.075)));
}
