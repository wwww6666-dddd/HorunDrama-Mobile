/**
 * 封面代理 + 按字节的 LRU 磁盘缓存。
 *
 * 为什么要代理：上游图床校验 referer/签名、且是 HEIC；浏览器直接吃会 403 或打不开。
 * 为什么按字节：一张几百 KB，按张数限等于没限（旧版踩过）。
 * 安全：只允许白名单图床，避免本地服务变成任意 URL 代理。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_ROOT, IMAGE_CACHE_BYTES } from '../config.ts';
import { createLogger } from '../util/log.ts';

const log = createLogger('images');

const ALLOWED = [
  'byteimg.com',
  'fqnovelpic.com',
  'douyinpic.com',
  'bytegecko.com',
  'bytetos.com',
  'fqnovelstatic.com',
  'bytecdn.cn',
  'pstatp.com',
  'snssdk.com',
  'byteimg.cn',
];

const MAGIC: Array<{ type: string; test: (b: Buffer) => boolean }> = [
  { type: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { type: 'image/gif', test: (b) => b.length > 4 && b.subarray(0, 4).toString('latin1') === 'GIF8' },
  {
    type: 'image/webp',
    test: (b) =>
      b.length > 12 &&
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  { type: 'image/avif', test: (b) => b.length > 12 && b.subarray(4, 12).toString('latin1') === 'ftypavif' },
  { type: 'image/heic', test: (b) => b.length > 12 && /^(ftyphei|ftypmif|ftypmsf)/.test(b.subarray(4, 12).toString('latin1')) },
];

function sniff(buf: Buffer): string {
  for (const m of MAGIC) if (m.test(buf)) return m.type;
  return 'application/octet-stream';
}

export function isAllowedImage(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return ALLOWED.some((s) => host === s || host.endsWith(`.${s}`));
  } catch {
    return false;
  }
}

const DIR = path.join(DATA_ROOT, 'cache', 'images');

interface Meta {
  size: number;
  lastUsed: number;
}

class ImageStore {
  private index = new Map<string, Meta>();
  private total = 0;
  private ready = false;

  private init(): void {
    if (this.ready) return;
    this.ready = true;
    try {
      fs.mkdirSync(DIR, { recursive: true });
      for (const name of fs.readdirSync(DIR)) {
        if (!/^[a-f0-9]{64}$/.test(name)) continue;
        try {
          const st = fs.statSync(path.join(DIR, name));
          this.index.set(name, { size: st.size, lastUsed: st.mtimeMs });
          this.total += st.size;
        } catch {
          /* 单文件失败不影响整体 */
        }
      }
      this.evict();
    } catch (err) {
      log.warn(`缓存目录初始化失败: ${(err as Error).message}`);
    }
  }

  async get(url: string): Promise<Buffer | null> {
    this.init();
    const hash = crypto.createHash('sha256').update(url).digest('hex');
    const meta = this.index.get(hash);
    if (meta === undefined) return null;
    try {
      const buf = await fsp.readFile(path.join(DIR, hash));
      meta.lastUsed = Date.now();
      return buf;
    } catch {
      this.index.delete(hash);
      this.total -= meta.size;
      return null;
    }
  }

  async put(url: string, buf: Buffer): Promise<void> {
    this.init();
    if (buf.length > IMAGE_CACHE_BYTES / 8) return;
    const hash = crypto.createHash('sha256').update(url).digest('hex');
    try {
      await fsp.writeFile(path.join(DIR, hash), buf);
    } catch (err) {
      log.warn(`写缓存失败: ${(err as Error).message}`);
      return;
    }
    const prev = this.index.get(hash);
    if (prev !== undefined) this.total -= prev.size;
    this.index.set(hash, { size: buf.length, lastUsed: Date.now() });
    this.total += buf.length;
    this.evict();
  }

  private evict(): void {
    if (this.total <= IMAGE_CACHE_BYTES) return;
    const entries = [...this.index.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [hash, meta] of entries) {
      if (this.total <= IMAGE_CACHE_BYTES) break;
      this.index.delete(hash);
      this.total -= meta.size;
      void fsp.rm(path.join(DIR, hash), { force: true }).catch(() => undefined);
    }
  }

  stats(): { count: number; bytes: number; limit: number } {
    return { count: this.index.size, bytes: this.total, limit: IMAGE_CACHE_BYTES };
  }

  /** 清空后重置内存索引（磁盘文件由调用方删除）。 */
  reset(): void {
    this.index.clear();
    this.total = 0;
  }
}

export const imageStore = new ImageStore();

export interface ImageResult {
  body: Buffer;
  contentType: string;
  fromCache: boolean;
}

export async function fetchImage(url: string): Promise<ImageResult> {
  if (!isAllowedImage(url)) throw new Error('image_host_not_allowed');

  const cached = await imageStore.get(url);
  if (cached !== null) return { body: cached, contentType: sniff(cached), fromCache: true };

  const res = await fetch(url, {
    headers: {
      accept: 'image/avif,image/webp,image/jpeg,image/png,*/*;q=0.8',
      // 图床对无 UA 的请求会 403
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`image_upstream_${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const contentType = sniff(body);
  if (!contentType.startsWith('image/')) throw new Error('image_not_image');
  await imageStore.put(url, body);
  return { body, contentType, fromCache: false };
}

export function imageCacheStats(): { count: number; bytes: number; limit: number; dir: string } {
  return { ...imageStore.stats(), dir: DIR };
}

/** 清空封面缓存。 */
export async function clearImageCache(): Promise<{ removed: number; bytes: number }> {
  const before = imageStore.stats();
  const names = await fsp.readdir(DIR).catch(() => [] as string[]);
  let removed = 0;
  for (const n of names) {
    if (!/^[a-f0-9]{64}$/.test(n)) continue;
    try {
      await fsp.rm(path.join(DIR, n), { force: true });
      removed += 1;
    } catch {
      /* 单个失败不影响整体 */
    }
  }
  imageStore.reset();
  return { removed, bytes: before.bytes };
}
