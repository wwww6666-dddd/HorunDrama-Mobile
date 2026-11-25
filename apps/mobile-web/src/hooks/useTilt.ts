import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

export interface TiltOptions {
  /** 最大 X 倾斜角度 */
  maxX?: number;
  /** 最大 Y 倾斜角度 */
  maxY?: number;
  /** 悬停放大倍率 */
  scale?: number;
  /** 悬停抬升像素 */
  lift?: number;
}

/**
 * 3D 倾斜 + 跟随光标柔光斑（可给任意卡片复用）。
 *
 * 只负责写 CSS 变量，不直接改 transform：
 * - `--rx/--ry/--scale/--lift` 由各卡片的 CSS 消费；
 * - `--mx/--my/--glare-opacity` 由 `.tilt-glare` 光斑消费。
 *
 * 用速度+阻尼弹簧（v += diff*k; v *= damping），松手有轻微回弹。
 */
/**
 * 光斑的坐标要相对于**光斑自己的父容器**（封面）算，不能拿整张卡片算。
 * 卡片还包含下面的标题/集数，封面只占卡片高度的一部分；用整卡高度算会让
 * 光斑中心比鼠标高一截（用户说的“在光标头部而不是中心”）。
 */
function pointInSurface(surface: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = surface.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width))),
    y: Math.min(1, Math.max(0, (clientY - rect.top) / Math.max(1, rect.height))),
  };
}

export function useTilt(ref: RefObject<HTMLElement | null>, options: TiltOptions = {}): void {
  const opts = useRef(options);
  opts.current = options;

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // 光斑在封面内；没有就退回整张卡
    const surface = el.querySelector<HTMLElement>('.tilt-glare')?.parentElement ?? el;

    const target = { rx: 0, ry: 0, scale: 1, lift: 0 };
    const current = { rx: 0, ry: 0, scale: 1, lift: 0 };
    const velocity = { rx: 0, ry: 0, scale: 0, lift: 0 };
    const STIFF = 0.18;
    const DAMP = 0.76;
    let raf = 0;
    let pointerX = 0;
    let pointerY = 0;
    let pointerInside = false;

    const tick = (): void => {
      velocity.rx += (target.rx - current.rx) * STIFF;
      velocity.ry += (target.ry - current.ry) * STIFF;
      velocity.scale += (target.scale - current.scale) * STIFF;
      velocity.lift += (target.lift - current.lift) * STIFF;
      velocity.rx *= DAMP;
      velocity.ry *= DAMP;
      velocity.scale *= DAMP;
      velocity.lift *= DAMP;
      current.rx += velocity.rx;
      current.ry += velocity.ry;
      current.scale += velocity.scale;
      current.lift += velocity.lift;
      el.style.setProperty('--rx', `${current.rx.toFixed(2)}deg`);
      el.style.setProperty('--ry', `${current.ry.toFixed(2)}deg`);
      el.style.setProperty('--scale', current.scale.toFixed(3));
      el.style.setProperty('--lift', `${current.lift.toFixed(2)}px`);
      // 卡片还在旋转时，屏幕上的同一光标会对应不同的局部坐标；
      // 每帧按当前 transform 反算一次，光斑才不会“飘到光标头部/后面”。
      if (pointerInside) {
        const point = pointInSurface(surface, pointerX, pointerY);
        el.style.setProperty('--mx', `${(point.x * 100).toFixed(1)}%`);
        el.style.setProperty('--my', `${(point.y * 100).toFixed(1)}%`);
      }
      const settled =
        Math.abs(current.rx - target.rx) < 0.02 &&
        Math.abs(current.ry - target.ry) < 0.02 &&
        Math.abs(current.scale - target.scale) < 0.001 &&
        Math.abs(current.lift - target.lift) < 0.05;
      raf = settled ? 0 : window.requestAnimationFrame(tick);
    };
    const kick = (): void => {
      if (raf === 0) raf = window.requestAnimationFrame(tick);
    };

    const onMove = (event: PointerEvent): void => {
      const rect = el.getBoundingClientRect();
      const x = (event.clientX - rect.left) / Math.max(1, rect.width);
      const y = (event.clientY - rect.top) / Math.max(1, rect.height);
      pointerX = event.clientX;
      pointerY = event.clientY;
      pointerInside = true;
      const o = opts.current;
      target.rx = (0.5 - y) * (o.maxX ?? 14);
      target.ry = (x - 0.5) * (o.maxY ?? 16);
      target.scale = o.scale ?? 1.035;
      target.lift = o.lift ?? -6;
      const point = pointInSurface(surface, pointerX, pointerY);
      el.style.setProperty('--mx', `${(point.x * 100).toFixed(1)}%`);
      el.style.setProperty('--my', `${(point.y * 100).toFixed(1)}%`);
      el.style.setProperty('--glare-opacity', '0.85');
      kick();
    };
    const onLeave = (): void => {
      pointerInside = false;
      target.rx = 0;
      target.ry = 0;
      target.scale = 1;
      target.lift = 0;
      el.style.setProperty('--glare-opacity', '0');
      kick();
    };

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('pointerup', onLeave);
    el.addEventListener('pointercancel', onLeave);
    return () => {
      if (raf !== 0) window.cancelAnimationFrame(raf);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('pointerup', onLeave);
      el.removeEventListener('pointercancel', onLeave);
    };
  }, [ref]);
}
