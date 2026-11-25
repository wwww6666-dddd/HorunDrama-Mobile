/**
 * App 源客户端（openhongguo SDK / WASM）。
 *
 * 为什么走 App 源：官网是 SEO 落地页，只收录一部分剧、且每部只放前几集；
 * 全量库、搜索、榜单、筛选、上新、多季都在 App 接口里。签名与设备档案由 SDK
 * 负责（gorgon/medusa/helios + 匿名设备自举），这里只做三件事：
 *   1. 单例 + 瞬时失败重试
 *   2. 上游形状 → 我们的 Drama
 *   3. 封面 HEIC 签名 URL → 免签 JPEG 变体
 */
import path from 'node:path';
import { createClient, type Client, type SeriesSummary } from 'openhongguo';
import { DATA_ROOT } from '../config.ts';
import { createLogger } from '../util/log.ts';
import type { Drama } from '../types.ts';

const log = createLogger('app');

let clientPromise: Promise<Client> | null = null;

export function getClient(): Promise<Client> {
  clientPromise ??= createClient({
    // 设备档案与登录/账号包完全分开：这是"匿名浏览设备"，不是账号设备
    profile: path.join(DATA_ROOT, 'app-device.json'),
    log: (line) => log.debug(line),
    retryAttempts: 3,
    deviceResets: 2,
    timeoutMs: 20_000,
  }).catch((err: unknown) => {
    clientPromise = null;
    throw err;
  });
  return clientPromise;
}

function isTransient(err: unknown): boolean {
  const code = (err as { code?: string }).code ?? '';
  const message = (err as { message?: string }).message ?? '';
  return (
    code === 'ANONYMOUS_LIMITED' ||
    code === 'RATE_LIMITED' ||
    code === 'DEVICE_REJECTED' ||
    code === 'TRANSPORT' ||
    /empty|timeout|ECONNRESET/i.test(message)
  );
}

/** 匿名设备被判空结果/被拒：换一台设备档案再试才有用；RATE_LIMITED 换身份无效（实测）。 */
function needsDeviceReset(err: unknown): boolean {
  const code = (err as { code?: string }).code ?? '';
  return code === 'ANONYMOUS_LIMITED' || code === 'DEVICE_REJECTED';
}

/**
 * 同一身份 90s 内只换一次设备：换身份对当前这轮限流无效（实测），
 * 每次失败都重新注册会连着打注册接口，反而更像异常客户端。
 */
const DEVICE_ROTATE_COOLDOWN_MS = 90_000;
let deviceRotatedAt = 0;

async function rotateDevice(label: string): Promise<void> {
  const remaining = DEVICE_ROTATE_COOLDOWN_MS - (Date.now() - deviceRotatedAt);
  if (remaining > 0) {
    log.warn(`${label}：${Math.ceil(remaining / 1000)}s 内刚换过匿名设备，沿用当前档案重试`);
    return;
  }
  deviceRotatedAt = Date.now();
  const client = await getClient();
  await client.resetDevice();
  log.warn(`${label}：已更换匿名设备档案`);
}

/** 指数退避（800ms 起、8s 封顶、±15% 抖动），上游给了 retryAfterMs 就取两者较大值。 */
const RETRY_BASE_MS = 800;
const RETRY_MAX_MS = 8_000;

function backoffMs(attempt: number, base: number, hintMs: number): number {
  const exp = Math.min(base * 2 ** (attempt - 1), RETRY_MAX_MS);
  const jittered = exp * (0.85 + Math.random() * 0.3);
  const floor = Math.min(hintMs, RETRY_MAX_MS);
  return Math.min(Math.max(jittered, floor), RETRY_MAX_MS);
}

/**
 * 限流/空响应很常见，退避重试往往就好；不吞掉真正的参数错误。
 * 默认 3 次（阶段 0 定的口径）：第一次失败等 ~0.8s，第二次 ~1.6s，最坏多等 2.4s。
 * 播放链路自己传 1，见 sources/playback.ts。
 */
export async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3, baseMs = RETRY_BASE_MS): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isTransient(err) || i === attempts) break;
      if (needsDeviceReset(err)) {
        await rotateDevice(label).catch((e: unknown) => log.warn(`更换匿名设备失败: ${(e as Error).message}`));
      }
      const hintMs = (err as { retryAfterMs?: number }).retryAfterMs ?? 0;
      const waitMs = backoffMs(i, baseMs, hintMs);
      log.warn(`${label} 第 ${i} 次失败（${(err as Error).message}），${Math.round(waitMs)}ms 后重试`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw last;
}

/** App 返回 HEIC + 长签名 URL；同 hash 在 byteimg 上有免签 JPEG 变体。换不动就退回原图。 */
export function normalizeCover(raw: string): string {
  if (raw === '') return '';
  try {
    const p = new URL(raw, 'https://x').pathname;
    const m = /\/novel-pic\/([0-9a-z]+)~tplv-[^/]+$/i.exec(p);
    if (m?.[1] !== undefined) return `https://p6-novel.byteimg.com/novel-pic/${m[1]}~tplv-shrink:640:0.image`;
  } catch {
    /* 非法 URL 直接原样返回 */
  }
  return raw;
}

function heatText(n: number | undefined): string {
  if (n === undefined || n <= 0) return '';
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿热度`;
  if (n >= 10_000) return `${Math.round(n / 10_000)}万热度`;
  return `${n}热度`;
}

export function toDrama(s: SeriesSummary): Drama {
  const extra = s as SeriesSummary & { heat?: number; category?: string; status?: number };
  return {
    seriesId: s.id,
    title: s.title,
    cover: normalizeCover(s.cover_url ?? ''),
    intro: s.description ?? '',
    episodeCount: s.episode_count ?? 0,
    finished: extra.status === 1,
    heatText: heatText(extra.heat),
    tags: extra.category !== undefined && extra.category !== '' ? [extra.category] : [],
  };
}
