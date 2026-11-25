/** 本地快照：进页面先用上次的数据把界面铺满，再后台刷新，避免每次都白屏转圈。 */
const PREFIX = 'horun-snap:';
/** 超过 24 小时视为过期，避免拿上个月的推荐当首屏。 */
const MAX_AGE = 24 * 60 * 60 * 1000;

interface Envelope<T> {
  at: number;
  data: T;
}

export function readSnapshot<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Envelope<T>;
    if (!parsed || typeof parsed.at !== 'number' || Date.now() - parsed.at > MAX_AGE) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function writeSnapshot<T>(key: string, data: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ at: Date.now(), data } satisfies Envelope<T>));
  } catch {
    /* 配额满了就让 localStorage 自己淘汰；不能因为快照写不进去影响业务 */
  }
}

export function dropSnapshot(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}
