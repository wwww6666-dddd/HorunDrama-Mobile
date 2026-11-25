import { useEffect, useRef } from 'react';
import type { JSX } from 'react';

/**
 * 触底哨兵：进入视口前 600px 就触发（不等真的贴底，滚动更顺）。
 *
 * 为什么用 IntersectionObserver 而不是 scroll 事件：滚动容器是 .app__main，
 * 监听 scroll 需要额外处理节流与容器解析；IO 两行就够，也不会掉帧。
 */
export function InfiniteSentinel({
  onReach,
  disabled,
}: {
  onReach: () => void;
  disabled?: boolean;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const reachRef = useRef(onReach);
  reachRef.current = onReach;

  useEffect(() => {
    const el = ref.current;
    if (el === null || disabled === true) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) reachRef.current();
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [disabled]);

  return <div ref={ref} className="infinite-sentinel" aria-hidden="true" />;
}
