/**
 * 高清取流：直接跑「红果 App 源」（video_model 系列接口），拿片源直链 + 内容密钥。
 *
 * 为什么要自己实现而不是用 openhongguo SDK：SDK 只打 `/novel/player/video_model/v1/`
 * 且复用同一个匿名设备。上游 2026-10-27 起会软拦截这类请求（HTTP 200 + 0 字节），
 * 2026-11-10 起还要求 gzip 正文 + 每次重新注册播放身份 + 真 argus/ladon 签名。
 * 结果是 SDK 取流总是「空响应」，我们只能退回官网 360p。
 *
 * 这里复用的实现来自 hongguo-web（MIT，见同目录 LICENSE-hongguo-web）：
 *  - service/playback-device.js：ttEncrypt 匿名设备注册（每次取流一个新身份）
 *  - service/app-source.js    ：签名请求 + 片源模型解析（含 video_tab 兜底）
 *  - core/spade.js            ：spade_a -> content key 解包
 *
 * 拿到的是 HEVC(bytevc1/hvc1) + CENC 加密的 mp4：交给 ffmpeg
 * `-decryption_key <hex>` 解密后再转 H.264，或（本来就是 h264 时）直接 -c copy。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { createLogger } from '../util/log.ts';
import type { StreamChoice } from './playback.ts';

const log = createLogger('appplay');

/** 最近一次取流失败原因（清晰度降级链用它判断"这集根本没戏"） */
let lastError = '';

export function lastAppError(): string {
  return lastError;
}

/** 只允许取这几档，避免把上游的奇怪字符串直接透传 */
const ALLOWED = new Set(['auto', '360p', '480p', '720p', '1080p']);
export const APP_QUALITY_CHOICES = ['360p', '480p', '720p', '1080p'];

interface AppSourceOut {
  url: string;
  spadeA: string;
  encrypt: boolean;
  definition: string;
  size?: string;
  codec?: string;
}

interface SpadeResult {
  key: string | null;
  flag: number;
}

interface AppSourceModule {
  fetch: (vid: string, quality: string, opts?: Record<string, unknown>) => Promise<AppSourceOut>;
  resetPlaybackDevice: () => void;
}

interface SpadeModule {
  spadeToKey: (b64: string, flag?: number) => SpadeResult;
}

let appSource: AppSourceModule | null = null;
let spade: SpadeModule | null = null;

/** 取流结果的短期缓存：同一集反复播放/换清晰度时不再打上游 */
interface CachedStream {
  stream: StreamChoice;
  fetchedAt: number;
}
const PENDING = new Map<string, Promise<StreamChoice | null>>();
const CACHE = new Map<string, CachedStream>();
/** 上游对播放请求有「同一身份/同一 IP 短时间重复取流判重」的行为，必须限速 */
const CACHE_TTL_MS = 20 * 60_000;
const MIN_GAP_MS = 1_500;

let lastFetchAt = 0;
let chain: Promise<unknown> = Promise.resolve();
/** 连续空响应次数：达到阈值就整体熔断一会儿，别再连着打上游 */
let emptyStreak = 0;
let breakerUntil = 0;
/** 熔断时长指数退避：2 分钟起步，最长 30 分钟（上游按 IP 限流时别一直撞） */
let breakerMs = 2 * 60_000;
const BREAKER_MAX_MS = 30 * 60_000;

/** 这些模块是 CommonJS，且放在带 package.json({"type":"commonjs"}) 的子目录里 */
function loadModules(): { appSource: AppSourceModule; spade: SpadeModule } {
  if (appSource !== null && spade !== null) return { appSource, spade };
  const require = createRequire(import.meta.url);
  const base = path.join(import.meta.dirname, '..', 'upstream', 'hongguoweb');
  appSource = require(path.join(base, 'service', 'app-source.js')) as AppSourceModule;
  spade = require(path.join(base, 'core', 'spade.js')) as SpadeModule;
  return { appSource, spade };
}

/** 我们内部的清晰度偏好 -> 对方接口的 quality 参数 */
function normalizeQuality(prefer: string): string {
  return ALLOWED.has(prefer) ? prefer : 'auto';
}

/**
 * 取一集的高清流。失败返回 null（调用方会退化到官网 360p）。
 *
 * 上游限制（参考对方项目的实测记录）：播放身份一次性、取流之间至少隔 1s，
 * 短时间连续取流会被判重返回空。所以这里做了：结果缓存 20 分钟、
 * 全局串行 + 1.5s 间隔、连续 2 次空响应就熔断 3 分钟。
 */
export async function resolveAppStream(
  episodeId: string,
  prefer = 'auto',
  /** 失败是否计入熔断：清晰度降级链里的中间档传 false（上游没这一档 ≠ 限流） */
  countFailure = true,
): Promise<StreamChoice | null> {
  const quality = normalizeQuality(prefer);
  const cacheKey = `${episodeId}|${quality}`;
  const hit = CACHE.get(cacheKey);
  if (hit !== undefined && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.stream;

  if (Date.now() < breakerUntil) return null;

  // 同一集同一个档位并发请求合并：秒开流和后台缓存会同时要这一集，
  // 不合并的话第二次会排在同一个串行队列里白等 1.5s
  const pending = PENDING.get(cacheKey);
  if (pending !== undefined) return pending;

  const run = chain.then(async () => {
    const wait = lastFetchAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastFetchAt = Date.now();
    try {
      const stream = await fetchOnce(episodeId, quality);
      if (stream !== null) {
        emptyStreak = 0;
        breakerMs = 2 * 60_000;
        CACHE.set(`${episodeId}|${quality}`, { stream, fetchedAt: Date.now() });
        CACHE.set(`${episodeId}|auto`, { stream, fetchedAt: Date.now() });
      } else if (countFailure) {
        emptyStreak += 1;
        if (emptyStreak >= 2) {
          breakerUntil = Date.now() + breakerMs;
          emptyStreak = 0;
          log.warn(`App 取流连续空响应，高清暂停 ${Math.round(breakerMs / 60_000)} 分钟（继续用官网 360p 秒开）`);
          breakerMs = Math.min(BREAKER_MAX_MS, breakerMs * 2);
        }
      }
      return stream;
    } catch (err) {
      lastError = (err as Error).message;
      if (countFailure) log.warn(`App 取流异常 ${episodeId}：${(err as Error).message}`);
      return null;
    }
  });
  PENDING.set(cacheKey, run);
  chain = run.catch(() => undefined);
  void run.finally(() => PENDING.delete(cacheKey));
  return run;
}

async function fetchOnce(episodeId: string, quality: string): Promise<StreamChoice | null> {
  const { appSource: source, spade: spadeMod } = loadModules();
  const out = await source.fetch(episodeId, quality, {});
  if (out.url === '') return null;
  const key = out.encrypt ? spadeMod.spadeToKey(out.spadeA) : { key: null, flag: 0 };
  if (out.encrypt && (key.key === null || !/^[0-9a-f]{32}$/.test(key.key))) {
    log.warn(`取流成功但密钥解不出 ${episodeId}（flag=${key.flag}）`);
    return null;
  }
  const stream: StreamChoice = {
    episodeId,
    definition: out.definition === '?' ? '原画' : out.definition,
    codec: out.codec ?? 'bytevc1',
    width: 0,
    height: 0,
    url: out.url,
    decryptionKey: key.key ?? '',
    protected: out.encrypt,
    durationSec: 0,
    available: APP_QUALITY_CHOICES,
  };
  log.info(
    `App 取流 ${episodeId}: ${stream.definition} ${stream.codec} protected=${String(stream.protected)} key=${stream.decryptionKey === '' ? '-' : 'ok'}`,
  );
  return stream;
}

/** 换一个新播放身份（上游判重时用；目前只在排障脚本里调） */
export function resetPlaybackIdentity(): void {
  const { appSource: source } = loadModules();
  source.resetPlaybackDevice();
}
