/** 极简 TTL 缓存：单飞 + 过期。目录类接口基本都是"短时间重复点击"，够用了。 */
export class TtlCache<T> {
  private readonly map = new Map<string, { value: T; expiresAt: number }>();
  private readonly max: number;
  private readonly ttlMs: number;

  constructor(max: number, ttlMs: number) {
    this.max = max;
    this.ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T): void {
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  async wrap(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await load();
    this.set(key, value);
    return value;
  }
}

/**
 * 上游是游标分页，界面是页码。这里维护每个查询的游标链：
 * 取第 N 页必须知道第 N-1 页返回的 cursor，所以只能顺序翻。
 */
interface Chain {
  cursors: Array<string | undefined>;
  hasMore: boolean;
}

export class CursorPager<T> {
  private readonly chains = new Map<string, Chain>();
  private readonly pages = new Map<string, { items: T[]; page: number; hasMore: boolean }>();
  private readonly maxPages: number;

  constructor(maxPages = 512) {
    this.maxPages = maxPages;
  }

  async page(
    key: string,
    page: number,
    fetch: (cursor: string | undefined) => Promise<{ items: T[]; cursor?: string; hasMore: boolean }>,
  ): Promise<{ items: T[]; page: number; hasMore: boolean }> {
    const cacheKey = `${key}#${page}`;
    const cached = this.pages.get(cacheKey);
    if (cached) return cached;

    let chain = this.chains.get(key) ?? { cursors: [undefined], hasMore: true };
    this.chains.set(key, chain);

    while (chain.cursors.length < page && chain.hasMore) {
      const prevPage = chain.cursors.length;
      const prev = await this.page(key, prevPage, fetch);
      if (!prev.hasMore) break;
      chain = this.chains.get(key) ?? chain;
    }

    const cursor = chain.cursors[page - 1];
    if (cursor === undefined && page > 1) {
      return { items: [], page, hasMore: false };
    }

    const result = await fetch(cursor);
    // 上游把同一个 cursor 又回给我们 == 它不打算再翻页了（搜索接口实测会这样）
    const stuck = cursor !== undefined && result.cursor === cursor;
    if (chain.cursors.length <= page) chain.cursors[page] = result.cursor;
    chain.hasMore = result.hasMore && !stuck;

    const out = { items: result.items, page, hasMore: result.hasMore };
    if (this.pages.size > this.maxPages) {
      const oldest = this.pages.keys().next().value;
      if (oldest !== undefined) this.pages.delete(oldest);
    }
    this.pages.set(cacheKey, out);
    return out;
  }
}
