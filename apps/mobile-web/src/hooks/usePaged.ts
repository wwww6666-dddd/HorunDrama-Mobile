import { useCallback, useEffect, useRef, useState } from 'react';

export interface PagedLike<T> {
  items: T[];
  page: number;
  hasMore: boolean;
}

interface Options<T> {
  /** 去重用的稳定 id；分页接口偶尔会回重复条目 */
  idOf?: (item: T) => string;
  /** 每页回来时回调（用于取首屏附带的元信息，如榜单分组） */
  onPage?: (result: PagedLike<T>, page: number) => void;
}

const defaultId = (item: unknown): string => JSON.stringify(item);

/**
 * 分页读取 + 追加 + 去重。
 *
 * 只做三件事：首屏重置、加载更多追加、同一时刻只允许一个在途请求。
 * 触底自动加载交给 <InfiniteSentinel/>；这里保持纯粹，方便测试与复用。
 *
 * 一个实测过的坑：搜索接口会把同一页反复返回（hasMore 恒 true）。
 * 所以「这一页没长出新条目」必须当成到底，否则会无限触底。
 */
export function usePaged<T>(
  keys: unknown[],
  load: (page: number, signal: AbortSignal) => Promise<PagedLike<T>>,
  options: Options<T> = {},
): {
  items: T[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  moreLoading: boolean;
  loadMore: () => void;
  reload: () => void;
} {
  const [items, setItems] = useState<T[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [moreLoading, setMoreLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const loadRef = useRef(load);
  loadRef.current = load;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  /** 与 items 同步的镜像：分页追加需要"当前已展示多少"，不能等 setState 回读 */
  const itemsRef = useRef<T[]>([]);
  /** 任一请求在途就拒绝新的"加载更多"，防止快速滚动打出并发 */
  const busy = useRef(false);

  const merge = useCallback((prev: T[], next: T[], idOf: (item: T) => string): T[] => {
    const seen = new Set(prev.map(idOf));
    const out = [...prev];
    for (const item of next) {
      const key = idOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }, []);

  // 首屏 / 换条件：整表重置
  useEffect(() => {
    const ctrl = new AbortController();
    busy.current = true;
    itemsRef.current = [];
    setLoading(true);
    setError(null);
    setItems([]);
    setPage(0);
    setHasMore(true);

    loadRef
      .current(1, ctrl.signal)
      .then((result) => {
        if (ctrl.signal.aborted) return;
        const idOf = optionsRef.current.idOf ?? defaultId;
        const merged = merge([], result.items, idOf);
        itemsRef.current = merged;
        setItems(merged);
        setPage(result.page);
        setHasMore(result.hasMore && merged.length > 0);
        optionsRef.current.onPage?.(result, 1);
      })
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted) setError((err as Error).message);
      })
      .finally(() => {
        busy.current = false;
        if (!ctrl.signal.aborted) setLoading(false);
      });

    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, ...keys]);

  const loadMore = useCallback((): void => {
    if (busy.current || loading || moreLoading || !hasMore) return;
    const nextPage = page + 1;
    busy.current = true;
    setMoreLoading(true);

    loadRef
      .current(nextPage, new AbortController().signal)
      .then((result) => {
        const idOf = optionsRef.current.idOf ?? defaultId;
        const merged = merge(itemsRef.current, result.items, idOf);
        const grew = merged.length > itemsRef.current.length;
        itemsRef.current = merged;
        setItems(merged);
        setPage(result.page);
        // 没有新条目 == 上游在重复回同一页，直接收到底
        setHasMore(result.hasMore && grew);
        optionsRef.current.onPage?.(result, nextPage);
      })
      .catch((err: unknown) => {
        // 追加失败不打断已展示内容，只停止继续触底
        setError((err as Error).message);
        setHasMore(false);
      })
      .finally(() => {
        busy.current = false;
        setMoreLoading(false);
      });
  }, [hasMore, loading, merge, moreLoading, page]);

  return {
    items,
    loading,
    error,
    hasMore,
    moreLoading,
    loadMore,
    reload: () => setNonce((n) => n + 1),
  };
}
