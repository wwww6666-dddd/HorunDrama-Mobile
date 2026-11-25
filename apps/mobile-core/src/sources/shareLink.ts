/**
 * 红果短链展开。
 *
 * 官方 App 分享有时给的是 `https://novelquickapp.com/s/<code>/` 短链，
 * 它本身不带 video_id/vid，必须先跟随 302 到 `.../video-animation-share?video_id=…&vid=…`。
 *
 * 只允许红果自己的域名，避免这个本地接口被当成任意 URL 的代理（SSRF）。
 */

const SHORT_HOSTS = new Set([
  'novelquickapp.com',
  'www.novelquickapp.com',
  'iesdouyin.com',
  'www.iesdouyin.com',
  'douyin.com',
  'www.douyin.com',
]);

const SHORT_PATH = /^\/s\/[A-Za-z0-9_-]+\/?$/;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_HOPS = 4;
const UA =
  'Mozilla/5.0 (Linux; Android 12; TGR-W10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

export class ShareLinkError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ShareLinkError';
    this.status = status;
    this.code = code;
  }
}

interface CacheEntry {
  url: string;
  at: number;
}

const cache = new Map<string, CacheEntry>();

function pickUrl(raw: string): string {
  const m = /https?:\/\/[^\s<>"'，。！？、；：）】」』\u3000\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/i.exec(raw.trim());
  return m === null ? '' : m[0].replace(/[.,;:!?]+$/g, '');
}

function asUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** 是不是「可展开」的红果短链（仅用于前端提示，不负责网络请求）。 */
export function isShareShortLink(raw: string): boolean {
  const input = pickUrl(raw);
  if (input === '') return false;
  const u = asUrl(input);
  if (u === null) return false;
  return SHORT_HOSTS.has(u.hostname.toLowerCase()) && SHORT_PATH.test(u.pathname);
}

function hasShareIds(u: URL): boolean {
  return u.searchParams.has('video_id') || u.searchParams.has('book_id');
}

function assertAllowed(u: URL): void {
  if (!SHORT_HOSTS.has(u.hostname.toLowerCase())) {
    throw new ShareLinkError(400, 'share_host', '只支持红果短链，不代理其他网站');
  }
}

/** 跟随短链，返回带 video_id/vid 的最终地址；结果缓存 10 分钟。 */
export async function resolveShareShortLink(raw: string): Promise<string> {
  const input = pickUrl(raw);
  if (input === '') throw new ShareLinkError(400, 'share_url', '没有找到可展开的链接');
  const start = asUrl(input);
  if (start === null) throw new ShareLinkError(400, 'share_url', '链接格式不对');
  assertAllowed(start);
  if (!SHORT_PATH.test(start.pathname)) {
    throw new ShareLinkError(400, 'share_path', '这不是红果的 /s/ 短链');
  }

  const key = start.toString();
  const hit = cache.get(key);
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.url;

  let current = start;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const res = await fetch(current, {
      redirect: 'manual',
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
      signal: AbortSignal.timeout(10_000),
    }).catch((err: unknown) => {
      throw new ShareLinkError(502, 'share_network', `展开短链失败：${(err as Error).message}`);
    });

    if (hasShareIds(current)) break;

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location !== null) {
      void res.body?.cancel();
      const next = asUrl(new URL(location, current).toString());
      if (next === null) throw new ShareLinkError(502, 'share_redirect', '短链跳转地址无效');
      assertAllowed(next);
      current = next;
      continue;
    }

    // 部分 CDN 会直接 200 + meta refresh/脚本，不返回 Location；只从响应体里找红果链接。
    if (res.status === 200) {
      const body = (await res.text()).replace(/&amp;/g, '&');
      const candidate = /https?:\/\/[^"'<>\s]+/i.exec(body);
      if (candidate !== null) {
        const next = asUrl(candidate[0]);
        if (next !== null && SHORT_HOSTS.has(next.hostname.toLowerCase()) && hasShareIds(next)) {
          current = next;
          break;
        }
      }
      throw new ShareLinkError(422, 'share_target', '短链没有跳到红果分享页，可能已失效');
    }

    throw new ShareLinkError(502, 'share_status', `短链返回了 ${res.status}`);
  }

  if (!hasShareIds(current)) {
    throw new ShareLinkError(422, 'share_target', '短链展开后没找到剧号，可能已失效');
  }
  cache.set(key, { url: current.toString(), at: Date.now() });
  return current.toString();
}
