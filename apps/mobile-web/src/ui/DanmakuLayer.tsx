import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, JSX } from 'react';
import { type DanmakuItem } from '../api.ts';
import { danmakuFontSize, lanesFor, type DanmakuPrefs } from '../settings/danmaku.ts';

interface Live {
  key: string;
  text: string;
  lane: number;
  /** 挂载时刻（wall clock）：animationend 偶发丢失时用它兜底清理 */
  bornAt: number;
}

/**
 * 弹幕层。
 *
 * 两个旧坑在这里规避：
 *  - 不用 animation-delay 对齐时间（每次 timeupdate 重算会一顿一顿）：到点才挂载；
 *  - 不用播放时间清理（暂停时永远不消失）：animationend 自己移除。
 * 暂停只把动画 play-state 停住，条目冻结、恢复后继续。
 *
 * 外观（背景/占屏/字号）由 prefs 驱动：默认纯透明，只靠文字描边保证可读。
 */
export function DanmakuLayer({
  items,
  clockMs,
  paused,
  episodeKey,
  prefs,
}: {
  items: DanmakuItem[];
  clockMs: number;
  paused: boolean;
  episodeKey: string;
  prefs: DanmakuPrefs;
}): JSX.Element {
  const [live, setLive] = useState<Live[]>([]);
  const seen = useRef(new Set<string>());
  /** 每条轨道上次放入弹幕的时间：优先选最久没用的轨道，避免同一行叠字 */
  const laneBusy = useRef<number[]>([]);
  const clockRef = useRef(clockMs);
  clockRef.current = clockMs;
  /** 上一次渲染看到的位置，用来识别拖进度造成的跳变。 */
  const lastSeekClock = useRef(clockMs);
  /** 只有位置在推进时才解除 CSS 冻结；避免 paused 状态因事件丢失而永久卡住。 */
  const lastAdvanceClock = useRef(clockMs);
  /** 上一轮“放弹幕”时看到的位置：用来把分批到达的时间跨度放宽到 2.5~6 秒。 */
  const lastDueClock = useRef(clockMs);
  const clockMoving = clockMs > lastAdvanceClock.current + 80;
  const effectivePaused = paused && !clockMoving;

  const lanes = lanesFor(prefs.coverage);
  const maxLive = lanes * 10;

  // 换集清空
  useEffect(() => {
    seen.current = new Set();
    laneBusy.current = [];
    lastSeekClock.current = clockMs;
    lastAdvanceClock.current = clockMs;
    lastDueClock.current = clockMs;
    setLive([]);
  }, [episodeKey]);

  /**
   * 用户拖动进度（前进/后退超过 1.5s）：清掉屏上旧条目、清空 seen。
   * 旧版只清屏不清 seen，拖回前面后同样的弹幕 id 永远不会再出现，
   * 看起来就是“弹幕卡住了/后半段没弹幕”。
   */
  useEffect(() => {
    const delta = clockMs - lastSeekClock.current;
    lastSeekClock.current = clockMs;
    if (Math.abs(delta) > 1500) {
      seen.current = new Set();
      laneBusy.current = [];
      setLive([]);
    }
    lastAdvanceClock.current = clockMs;
  }, [clockMs]);

  // animationend 在后台标签页/全屏切换时可能丢失；兜底清掉超时条目，防止越堆越多导致卡顿。
  useEffect(() => {
    if (live.length === 0 || effectivePaused) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setLive((prev) => prev.filter((it) => now - it.bornAt < 9800));
    }, 1200);
    return () => window.clearInterval(timer);
  }, [live.length, effectivePaused]);

  useEffect(() => {
    if (effectivePaused) return;
    const now = clockRef.current;
    // timeupdate 偶尔会隔 3~4s 才来一次；窗口至少覆盖 2.5s，并按两帧之间的跨度放宽，
    // 否则刚好落在空档里的弹幕会被永久跳过（表现也是“弹幕卡住”）。
    const prev = lastDueClock.current;
    lastDueClock.current = now;
    const span = Math.max(2500, Math.min(Math.max(0, now - prev) + 350, 6000));
    const due = items.filter(
      (it) => !seen.current.has(it.id) && it.offsetMs <= now && it.offsetMs > now - span,
    );
    if (due.length === 0) return;

    setLive((prevLive) => {
      const next = [...prevLive];
      const wall = Date.now();
      // 每条轨道当前在屏条数：同一批同时触发的弹幕必须分到不同轨道，否则叠字
      const occupancy = new Array<number>(lanes).fill(0);
      for (const item of next) occupancy[item.lane] = (occupancy[item.lane] ?? 0) + 1;

      for (const it of due) {
        seen.current.add(it.id);
        if (next.length >= maxLive) continue;

        let best = 0;
        let bestScore = Number.POSITIVE_INFINITY;
        for (let i = 0; i < lanes; i += 1) {
          // 先比"在屏条数"，再惩罚"刚放过"的轨道：
          // 同一轨道 2.4 秒内再放一条，会和刚出去那条在右侧叠字。
          const gap = wall - (laneBusy.current[i] ?? 0);
          const tooSoon = gap < 2400 ? 2400 - gap : 0;
          const score = (occupancy[i] ?? 0) * 10_000_000 + tooSoon;
          if (score < bestScore) {
            bestScore = score;
            best = i;
          }
        }
        laneBusy.current[best] = wall;
        occupancy[best] = (occupancy[best] ?? 0) + 1;
        next.push({ key: it.id, text: it.text, lane: best, bornAt: wall });
      }
      return next;
    });
  }, [clockMs, items, effectivePaused, lanes, maxLive]);

  const layerStyle = {
    height: `${Math.round(prefs.coverage * 100)}%`,
    '--dm-bg': prefs.background === 'soft' ? 'rgba(8, 7, 6, 0.34)' : 'transparent',
    '--dm-size': `${danmakuFontSize(prefs.size)}px`,
    '--dm-opacity': String(prefs.opacity),
    '--dm-weight': prefs.bold ? '700' : '400',
    '--dm-color': prefs.color,
  } as CSSProperties;

  return (
    <div className="danmaku-layer" data-paused={effectivePaused} data-bg={prefs.background} style={layerStyle} aria-hidden="true">
      {live.map((item) => (
        <span
          key={item.key}
          className="danmaku-item"
          style={{ top: `${((item.lane + 0.5) * 100) / lanes}%`, animationDuration: '9s' }}
          onAnimationEnd={() => setLive((prev) => prev.filter((x) => x.key !== item.key))}
        >
          {item.text}
        </span>
      ))}
    </div>
  );
}
