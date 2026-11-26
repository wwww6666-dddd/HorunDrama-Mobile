/**
 * 高清取流侧车：调用随 APK 打包的 Rust `hg-resolve`。
 *
 * 2026-11-23 上游播放接口改了请求校验：旧的纯 JS `x-helios/x-medusa`
 * 只能过一部分校验，`video_tab` 仍会返回 200 + 空 body。`hg-resolve`
 * 使用官方 7.4.3.32 的 MetaSec v5 / SDI 材料，能真实取到 1080p 直链
 * 和 CENC 内容密钥。
 *
 * 进程模型：每次取流 spawn 一次，进程内会复用设备档案和 MetaSec 会话；
 * 结果在 Node 侧缓存 20 分钟，避免同一集反复拉起。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { DATA_ROOT } from '../config.ts';
import { createLogger } from '../util/log.ts';
import type { StreamChoice } from './playback.ts';

const execFileAsync = promisify(execFile);
const log = createLogger('hgresolve');

const ALLOWED = new Set(['auto', '360p', '480p', '720p', '1080p']);
export const HGRESOLVE_QUALITY_CHOICES = ['360p', '480p', '540p', '720p', '1080p'];

interface ResolveOut {
  ok?: boolean;
  error?: string;
  url?: string;
  cenc_key_hex?: string;
  encrypted?: boolean;
  codec?: string;
  definition?: number;
  file_hash?: string;
  content_type?: number;
  qualities?: number[];
}

interface Cached {
  stream: StreamChoice;
  fetchedAt: number;
}

const CACHE = new Map<string, Cached>();
const PENDING = new Map<string, Promise<StreamChoice | null>>();
const CACHE_TTL_MS = 20 * 60_000;
/** 同一身份连续取流会被上游判重；串行间隔留够。 */
const MIN_GAP_MS = 1_500;
let lastFetchAt = 0;
let chain: Promise<unknown> = Promise.resolve();
let binaryLogged = false;

/** 找可执行的侧车：Android 从 nativeLibraryDir，PC 从工程 .tmp/或环境变量。 */
function findBinary(): string {
  const explicit = process.env.HORUN_HGRESOLVE ?? '';
  if (explicit !== '' && fs.existsSync(explicit)) return explicit;

  const dirs: string[] = [];
  for (const dir of (process.env.LD_LIBRARY_PATH ?? '').split(path.delimiter)) {
    if (dir !== '') dirs.push(dir);
  }
  dirs.push(path.resolve(import.meta.dirname, '../../vendor/hgresolve'));
  dirs.push(path.resolve(DATA_ROOT, 'hgresolve'));
  dirs.push(path.resolve(process.cwd(), '.tmp/hgresolve'));

  for (const dir of dirs) {
    for (const name of ['libhgresolve.so', 'hg-resolve', 'hg-resolve.exe']) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return '';
}

/** MetaSec 材料目录：core/vendor/hgresolve（APK assets 释放后的位置）。 */
function metasecDir(): string {
  const explicit = process.env.HONGGUO_METASEC_DIR ?? '';
  if (explicit !== '' && fs.existsSync(path.join(explicit, 'image.elf'))) return explicit;
  const dirs = [
    path.resolve(import.meta.dirname, '../../vendor/hgresolve/metasec'),
    path.resolve(import.meta.dirname, '../../vendor/hgresolve'),
    path.resolve(DATA_ROOT, 'hgresolve/metasec'),
  ];
  for (const dir of dirs) {
    if (fs.existsSync(path.join(dir, 'image.elf')) && fs.existsSync(path.join(dir, 'license.txt'))) {
      return dir;
    }
  }
  return '';
}

function definitionFor(prefer: string): number {
  if (!ALLOWED.has(prefer)) return 1080;
  if (prefer === 'auto') return 1080;
  const n = Number.parseInt(prefer, 10);
  return Number.isFinite(n) ? n : 1080;
}

/**
 * 取一集 1080p/720p 流。失败返回 null，调用方会继续走旧 App 源和官网 360p。
 */
export async function resolveHgStream(
  episodeId: string,
  prefer = 'auto',
): Promise<StreamChoice | null> {
  const definition = definitionFor(prefer);
  const cacheKey = `${episodeId}|${definition}`;
  const hit = CACHE.get(cacheKey);
  if (hit !== undefined && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.stream;

  const pending = PENDING.get(cacheKey);
  if (pending !== undefined) return pending;

  const run = chain.then(async () => {
    const wait = lastFetchAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastFetchAt = Date.now();
    try {
      const stream = await fetchOnce(episodeId, definition);
      if (stream !== null) {
        CACHE.set(`${episodeId}|${definition}`, { stream, fetchedAt: Date.now() });
        CACHE.set(`${episodeId}|auto`, { stream, fetchedAt: Date.now() });
      }
      return stream;
    } catch (err) {
      log.warn(`侧车取流异常 ${episodeId}: ${(err as Error).message}`);
      return null;
    }
  });
  PENDING.set(cacheKey, run);
  chain = run.catch(() => undefined);
  void run.finally(() => PENDING.delete(cacheKey));
  return run;
}

async function fetchOnce(episodeId: string, definition: number): Promise<StreamChoice | null> {
  const binary = findBinary();
  if (binary === '') {
    if (!binaryLogged) {
      log.warn('侧车 hg-resolve 不存在，高清回退旧 App 源');
      binaryLogged = true;
    }
    return null;
  }
  const material = metasecDir();
  if (material === '') {
    log.warn('侧车缺少 MetaSec 材料（image.elf/license.txt）');
    return null;
  }

  const workDir = path.resolve(DATA_ROOT, 'hgresolve');
  fs.mkdirSync(workDir, { recursive: true });
  const devicePath = path.join(workDir, 'device.json');
  const env = {
    ...process.env,
    HONGGUO_METASEC_DIR: material,
    HONGGUO_DEVICE_JSON: devicePath,
  };

  // series_id 传 0 + --ct 1004：跳过详情请求，直接按短剧类型取流。
  // 实测漫剧/真人剧都返回 1080p；拿不到时调用方再走旧链路。
  const args = ['0', episodeId, String(definition), '--ct', '1004', '--device', devicePath];
  const started = Date.now();
  const { stdout, stderr } = await execFileAsync(binary, args, {
    env,
    timeout: 45_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  if (stderr.trim() !== '') {
    for (const line of stderr.trim().split('\n').slice(-6)) log.debug(`侧车: ${line}`);
  }
  const line = stdout.trim().split('\n').filter((x) => x.startsWith('{')).pop() ?? '';
  if (line === '') {
    log.warn(`侧车无输出 ${episodeId} (${Date.now() - started}ms)`);
    return null;
  }
  let out: ResolveOut;
  try {
    out = JSON.parse(line) as ResolveOut;
  } catch {
    log.warn(`侧车输出不是 JSON ${episodeId}: ${line.slice(0, 120)}`);
    return null;
  }
  if (out.ok !== true || typeof out.url !== 'string' || out.url === '') {
    log.warn(`侧车取流失败 ${episodeId}: ${out.error ?? '空响应'}`);
    return null;
  }

  const actual = typeof out.definition === 'number' ? out.definition : definition;
  const available = [...new Set((out.qualities ?? []).filter((q) => Number.isFinite(q)))]
    .sort((a, b) => a - b)
    .map((q) => `${q}p`);
  const key = typeof out.cenc_key_hex === 'string' ? out.cenc_key_hex : '';
  if (out.encrypted === true && !/^[0-9a-f]{32}$/.test(key)) {
    log.warn(`侧车返回加密流但密钥不合法 ${episodeId}`);
    return null;
  }

  // 定义档位是纵坐标，按 16:9 反推宽度；下游只用它做元数据/占位。
  const width = actual >= 1080 ? 1920 : actual >= 720 ? 1280 : actual >= 540 ? 960 : actual >= 480 ? 854 : 640;

  const stream: StreamChoice = {
    episodeId,
    definition: `${actual}p`,
    codec: out.codec ?? 'bytevc1',
    width,
    height: actual,
    url: out.url,
    decryptionKey: key,
    protected: out.encrypted === true,
    durationSec: 0,
    available: available.length > 0 ? available : HGRESOLVE_QUALITY_CHOICES,
  };
  log.info(
    `侧车取流 ${episodeId}: ${stream.definition} ${stream.codec} protected=${String(stream.protected)} key=${key === '' ? '-' : 'ok'} (${Date.now() - started}ms)`,
  );
  return stream;
}

/** 排障用：清空侧车结果缓存，下一次重新取流。 */
export function clearHgResolveCache(): void {
  CACHE.clear();
}

/** 侧车是否就绪（不 spawn，只检查文件）。 */
export function hgResolveAvailable(): boolean {
  return findBinary() !== '' && metasecDir() !== '';
}
