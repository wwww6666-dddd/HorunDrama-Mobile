import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, JSX } from 'react';
import { type DanmakuItem } from '../api.ts';
import { danmakuFontSize, lanesFor, type DanmakuPrefs } from '../settings/danmaku.ts';

interface Live {
  key: string;
  text: string;
  lane: number;
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

  const lanes = lanesFor(prefs.coverage);
  const maxLive = lanes * 10;

  // 换集清空
  useEffect(() => {
    seen.current = new Set();
    laneBusy.current = [];
    setLive([]);
  }, [episodeKey]);

  useEffect(() => {
    if (paused) return;
    const now = clockRef.current;
    const due = items.filter(
      (it) => !seen.current.has(it.id) && it.offsetMs <= now && it.offsetMs > now - 2500,
    );
    if (due.length === 0) return;

    setLive((prev) => {
      const next = [...prev];
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
        next.push({ key: it.id, text: it.text, lane: best });
      }
      return next;
    });
  }, [clockMs, items, paused, lanes, maxLive]);

  const layerStyle = {
    height: `${Math.round(prefs.coverage * 100)}%`,
    '--dm-bg': prefs.background === 'soft' ? 'rgba(8, 7, 6, 0.34)' : 'transparent',
    '--dm-size': `${danmakuFontSize(prefs.size)}px`,
    '--dm-opacity': String(prefs.opacity),
    '--dm-weight': prefs.bold ? '700' : '400',
    '--dm-color': prefs.color,
  } as CSSProperties;

  return (
    <div className="danmaku-layer" data-paused={paused} data-bg={prefs.background} style={layerStyle} aria-hidden="true">
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
