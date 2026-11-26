/**
 * 手机端核心配置。
 *
 * 电脑端：监听 0.0.0.0，手机通过局域网连进来；
 * 独立 APK：监听 127.0.0.1，前端与核心都在手机本地，不再依赖电脑。
 */
import os from 'node:os';
import path from 'node:path';

export const VERSION = '1.3.8';

/**
 * 独立 APK 与电脑端共用同一套核心：
 * - 电脑端默认 0.0.0.0，手机通过局域网连进来；
 * - APK 内把 HORUN_HOST 固定为 127.0.0.1，只允许 WebView 本机访问。
 */
export const IS_ANDROID = process.platform === 'android';
export const HOST = process.env.HORUN_HOST ?? (IS_ANDROID ? '127.0.0.1' : '0.0.0.0');
export const PORT = Number.parseInt(process.env.HORUN_PORT ?? '5881', 10);

/** 是否接受局域网访问（PC 版只认本机 Host/Origin，这里默认放开） */
export const LAN = process.env.HORUN_LAN !== undefined ? process.env.HORUN_LAN !== '0' : !IS_ANDROID;

/** 数据目录：默认在工程内，便于整目录搬走/清理；可用 HORUN_DATA_DIR 覆盖 */
export const DATA_ROOT =
  process.env.HORUN_DATA_DIR !== undefined && process.env.HORUN_DATA_DIR !== ''
    ? path.resolve(process.env.HORUN_DATA_DIR)
    : path.resolve(import.meta.dirname, '../../../data');

export const WEB_DIST =
  process.env.HORUN_WEB_DIST !== undefined && process.env.HORUN_WEB_DIST !== ''
    ? path.resolve(process.env.HORUN_WEB_DIST)
    : path.resolve(import.meta.dirname, '../../mobile-web/dist');

/** 上游超时与最小请求间隔（防止把上游打穿）。 */
export const UPSTREAM_TIMEOUT_MS = 20_000;
export const UPSTREAM_MIN_GAP_MS = 120;

/** 封面缓存上限：按字节算，不按张数（大图会把张数限制造假）。 */
export const IMAGE_CACHE_BYTES = 96 * 1024 * 1024;

/** 本机所有可用于手机访问的 IPv4 地址 */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && item.internal === false) out.push(item.address);
    }
  }
  return out;
}

