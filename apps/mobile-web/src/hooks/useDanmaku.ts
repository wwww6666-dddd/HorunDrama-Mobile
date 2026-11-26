import { useEffect, useRef, useState } from 'react';
import { api, type DanmakuItem } from '../api.ts';

interface Meta {
  cursor: string;
  startMs: number;
  endMs: number;
  hasMore: boolean;
  loading: boolean;
  lastEnd: number;
}

/**
 * 按播放位置取弹幕。
 *
 * 两个必须防的坑：
 *  1. 上游"空页但 has_more=true"：不能靠 items 判断到底，要看 end_ms 有没有前进；
 *  2. 拖进度往回跳：必须从新位置重取，不然屏幕上会一直是后段的内容。
 */
export function useDanmaku(options: {
  seriesId: string;
  episodeId: string;
  enabled: boolean;
  ready: boolean;
  timeMs: number;
}): { items: DanmakuItem[]; loading: boolean } {
  const { seriesId, episodeId, enabled, ready, timeMs } = options;
  const [items, setItems] = useState<DanmakuItem[]>([]);
  const [loading, setLoading] = useState(false);
  const meta = useRef<Meta>({ cursor: '', startMs: 0, endMs: 0, hasMore: false, loading: false, lastEnd: 0 });
  /** 换集/关闭时递增；旧请求晚回来时直接丢弃，避免把上一集的弹幕灌进新一集。 */
  const seq = useRef(0);

  // 换集 / 开关变化：重置
  useEffect(() => {
    seq.current += 1;
    meta.current = { cursor: '', startMs: 0, endMs: 0, hasMore: false, loading: false, lastEnd: 0 };
    setItems([]);
  }, [episodeId, seriesId, enabled]);

  const load = async (startMs: number, cursor: string, append: boolean): Promise<void> => {
    if (meta.current.loading) return;
    const run = seq.current;
    meta.current.loading = true;
    setLoading(true);
    try {
      const res = await api.danmaku(seriesId, episodeId, startMs, cursor);
      if (run !== seq.current) return;
      meta.current = {
        cursor: res.nextCursor,
        startMs: res.startMs,
        endMs: res.endMs,
        hasMore: res.hasMore,
        loading: false,
        lastEnd: res.endMs,
      };
      setItems((prev) => {
        if (!append) return res.items;
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...res.items.filter((i) => !seen.has(i.id))];
      });
    } catch {
      if (run === seq.current) meta.current.loading = false;
    } finally {
      if (run === seq.current) setLoading(false);
    }
  };

  // 播放就绪后取第一段
  useEffect(() => {
    if (!enabled || !ready) return;
    void load(0, '', false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ready, seriesId, episodeId]);

  // 播到本段末尾前预取；往回拖则从新位置重取
  useEffect(() => {
    if (!enabled || !ready) return;
    const m = meta.current;
    if (m.endMs === 0) return;

    if (timeMs < m.startMs - 2000) {
      void load(timeMs, '', false);
      return;
    }
    if (!m.hasMore || m.loading) return;
    if (timeMs < m.endMs - 3000) return;
    // end_ms 没前进说明上游只是在重复回同一段，收手
    if (m.endMs <= m.lastEnd && m.cursor === '') return;
    void load(m.endMs, m.cursor, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeMs, enabled, ready]);

  return { items, loading };
}
