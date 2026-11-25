/**
 * Web 直连取流（hongguoduanju.com 的 fallback play-info）。
 *
 * 为什么需要它：App 源（SDK video_model）从 2026-11-16 傍晚起对匿名设备
 * 稳定返回 HTTP 200 + 空 body，导致「上游没有可播放的清晰度」，而且 App 源
 * 是 HEVC + CENC，必须整集下载 + 转码才能播，起播要几十秒（用户反馈「太卡」）。
 *
 * 官网 H5 播放器用 `POST /api/video/protected/fallback-play-info` 兜底：
 * 返回一个**普通 H.264 + AAC 的 mp4**（360p，约 550~700kbps），不加密、可 Range
 * 拖动、CDN 带 `access-control-allow-origin: *`，浏览器能直接播 → 秒开。
 *
 * 实测（2026-11-16）：
 * - 单集接口约 180~250ms；同一集短时间内返回同一 URL
 * - URL 带 `url_expire`（约 1 小时），过期后重新取一次即可
 * - 只提供一档「流畅 / 360p」，高清仍要走 App 源转码
 */
import { createLogger } from '../util/log.ts';

const log = createLogger('webplay');

const API = 'https://hongguoduanju.com/api/video/protected/fallback-play-info';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
/** 提前这么多毫秒当作过期，避免刚好卡在边界 */
const EXPIRE_MARGIN_MS = 60_000;

export interface WebStream {
  episodeId: string;
  url: string;
  definition: string;
  expiresAt: number;
}

interface Cached extends WebStream {
  fetchedAt: number;
}

const CACHE = new Map<string, Cached>();
/** 上游明确拒绝过的集，短时间内不再打，避免每次都白等超时 */
const BLOCKED = new Map<string, number>();
const MAX_CACHE = 400;

function trim(): void {
  if (CACHE.size <= MAX_CACHE) return;
  const sorted = [...CACHE.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
  for (const [key] of sorted.slice(0, CACHE.size - MAX_CACHE)) CACHE.delete(key);
}

function fresh(entry: Cached | undefined): boolean {
  if (entry === undefined) return false;
  if (entry.url === '') return false;
  return entry.expiresAt - EXPIRE_MARGIN_MS > Date.now();
}

async function requestOnce(episodeId: string, timeoutMs: number): Promise<WebStream | null> {
  const res = await fetch(`${API}?aid=8662`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/plain, */*',
      'x-xs-from-web': '1',
      'user-agent': UA,
      origin: 'https://hongguoduanju.com',
      referer: 'https://hongguoduanju.com/',
    },
    body: JSON.stringify({ item_id: episodeId }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    log.debug(`web 取流 HTTP ${res.status} ${episodeId}: ${text.slice(0, 120)}`);
    return null;
  }
  let json: { main_url?: string; url_expire?: number } | null = null;
  try {
    json = JSON.parse(text) as { main_url?: string; url_expire?: number };
  } catch {
    return null;
  }
  const url = json?.main_url ?? '';
  if (url === '') return null;
  const expiresAt = (json?.url_expire ?? 0) > 0 ? (json.url_expire as number) * 1000 : Date.now() + 30 * 60_000;
  return { episodeId, url, definition: '360p', expiresAt };
}

/**
 * 取一集的 web 直连地址。失败返回 null（调用方决定退化到哪条路）。
 * 命中缓存不发请求；一旦上游拒绝，同一个进程内 30 秒内不再重试，
 * 避免每集都白等一次超时。
 */
export async function resolveWebStream(episodeId: string): Promise<WebStream | null> {
  const cached = CACHE.get(episodeId);
  if (fresh(cached)) return cached ?? null;

  const blockedUntil = BLOCKED.get(episodeId) ?? 0;
  if (blockedUntil > Date.now()) return null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const stream = await requestOnce(episodeId, attempt === 0 ? 8_000 : 12_000);
      if (stream !== null) {
        CACHE.set(episodeId, { ...stream, fetchedAt: Date.now() });
        trim();
        log.debug(`web 直连 ${episodeId} → ${stream.definition} 有效至 ${new Date(stream.expiresAt).toISOString()}`);
        return stream;
      }
    } catch (err) {
      log.debug(`web 取流失败 ${episodeId}: ${(err as Error).message}`);
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
  }
  BLOCKED.set(episodeId, Date.now() + 30_000);
  return null;
}

/** 后台预热（不阻塞、不抛错），点下一集前先把地址取好。 */
export function warmWebStream(episodeId: string): void {
  if (fresh(CACHE.get(episodeId))) return;
  void resolveWebStream(episodeId).catch(() => undefined);
}

/**
 * 强制重取（忽略缓存）。CDN 返回 403 说明地址过期或换签了，
 * 代理层拿到新地址重试一次。
 */
export async function refreshWebStream(episodeId: string): Promise<WebStream | null> {
  CACHE.delete(episodeId);
  BLOCKED.delete(episodeId);
  return resolveWebStream(episodeId);
}

export function webStreamCached(episodeId: string): boolean {
  return fresh(CACHE.get(episodeId));
}

export function clearWebStreams(): void {
  CACHE.clear();
  BLOCKED.clear();
}
