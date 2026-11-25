/**
 * 本地设置：缓存目录、缓存上限、下载目录。
 *
 * 为什么单独存文件而不是塞进 SQLite：设置可能要在"库还没建好"时就能读，
 * 而且用户可能手改；JSON + mtime 缓存最省心（旧版踩过"改了不生效"的坑）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_ROOT } from '../config.ts';
import { createLogger } from '../util/log.ts';

const log = createLogger('settings');

export type QualityPref = 'auto' | 'smooth' | '480p' | '720p' | '1080p';
export type EnhanceLevel = 'off' | 'standard' | 'strong';

export interface Settings {
  /** 转码产物目录；可配置到别的盘 */
  mediaCacheDir: string;
  /** 转码缓存上限（MB） */
  mediaCacheMB: number;
  /** 下载目录 */
  downloadDir: string;
  /**
   * 默认清晰度：默认最高（1080p），上游没有该档会自动降级；
   * auto = 本地缓存的高清优先、否则 360p 秒开；smooth = 只用 360p 直连
   */
  defaultQuality: QualityPref;
  /** 同时下载几集（1~4） */
  downloadConcurrency: number;
  /** 一集播完自动下一集 */
  autoPlayNext: boolean;
  /** 默认倍速（0.75~2） */
  defaultSpeed: number;
  /** 跳过片头（秒，0=不跳） */
  skipIntroSec: number;
  /** 跳过片尾（秒，0=不跳；配合自动下一集） */
  skipOutroSec: number;
  /** 追剧页给有新集的剧打标（应用内提醒） */
  notifyNewEpisodes: boolean;
  /** 打开追剧页时自动同步账号数据 */
  autoSyncAccount: boolean;
  /** 画质增强：转码时降噪 + 锐化（off / standard / strong） */
  enhanceVideo: EnhanceLevel;
  /**
   * 预加载集数：以当前播放的集为中心，向前、向后各预加载这么多集
   * （0 = 关闭）。预加载只排队转码，不会打断正在播的。
   */
  preloadCount: number;
}

const FILE = path.join(DATA_ROOT, 'settings.json');

const DEFAULTS: Settings = {
  mediaCacheDir: path.join(DATA_ROOT, 'cache', 'media'),
  mediaCacheMB: 4096,
  downloadDir:
    process.env.HORUN_DOWNLOAD_DIR !== undefined && process.env.HORUN_DOWNLOAD_DIR !== ''
      ? path.resolve(process.env.HORUN_DOWNLOAD_DIR)
      : path.join(os.homedir(), 'Downloads', 'HorunDrama'),
  defaultQuality: '1080p',
  downloadConcurrency: 2,
  autoPlayNext: true,
  defaultSpeed: 1,
  skipIntroSec: 0,
  skipOutroSec: 0,
  notifyNewEpisodes: true,
  autoSyncAccount: true,
  enhanceVideo: 'off',
  preloadCount: 5,
};

let cache: Settings | null = null;
let cacheMtime = -1;

function sane(input: Partial<Settings>): Settings {
  const out: Settings = { ...DEFAULTS };
  if (typeof input.mediaCacheDir === 'string' && input.mediaCacheDir.trim() !== '') {
    out.mediaCacheDir = path.resolve(input.mediaCacheDir);
  }
  if (typeof input.mediaCacheMB === 'number' && Number.isFinite(input.mediaCacheMB)) {
    // 太小会让"同一集反复转码"，太大可能吃满盘
    out.mediaCacheMB = Math.min(100_000, Math.max(256, Math.round(input.mediaCacheMB)));
  }
  if (typeof input.downloadDir === 'string' && input.downloadDir.trim() !== '') {
    out.downloadDir = path.resolve(input.downloadDir);
  }
  if (
    input.defaultQuality === 'auto' ||
    input.defaultQuality === 'smooth' ||
    input.defaultQuality === '480p' ||
    input.defaultQuality === '720p' ||
    input.defaultQuality === '1080p'
  ) {
    out.defaultQuality = input.defaultQuality;
  }
  if (typeof input.preloadCount === 'number' && Number.isFinite(input.preloadCount)) {
    out.preloadCount = Math.max(0, Math.min(10, Math.round(input.preloadCount)));
  }
  if (typeof input.downloadConcurrency === 'number' && Number.isFinite(input.downloadConcurrency)) {
    out.downloadConcurrency = Math.min(4, Math.max(1, Math.round(input.downloadConcurrency)));
  }
  if (typeof input.autoPlayNext === 'boolean') out.autoPlayNext = input.autoPlayNext;
  if (typeof input.defaultSpeed === 'number' && Number.isFinite(input.defaultSpeed)) {
    out.defaultSpeed = Math.round(Math.min(2, Math.max(0.75, input.defaultSpeed)) * 100) / 100;
  }
  if (typeof input.skipIntroSec === 'number' && Number.isFinite(input.skipIntroSec)) {
    out.skipIntroSec = Math.min(120, Math.max(0, Math.round(input.skipIntroSec)));
  }
  if (typeof input.skipOutroSec === 'number' && Number.isFinite(input.skipOutroSec)) {
    out.skipOutroSec = Math.min(120, Math.max(0, Math.round(input.skipOutroSec)));
  }
  if (typeof input.notifyNewEpisodes === 'boolean') out.notifyNewEpisodes = input.notifyNewEpisodes;
  if (typeof input.autoSyncAccount === 'boolean') out.autoSyncAccount = input.autoSyncAccount;
  if (input.enhanceVideo === 'off' || input.enhanceVideo === 'standard' || input.enhanceVideo === 'strong') {
    out.enhanceVideo = input.enhanceVideo;
  }
  return out;
}

export function getSettings(): Settings {
  let mtime = -1;
  try {
    mtime = fs.statSync(FILE).mtimeMs;
  } catch {
    mtime = -1;
  }
  if (cache !== null && mtime === cacheMtime) return cache;

  if (mtime === -1) {
    cache = DEFAULTS;
    cacheMtime = -1;
    return cache;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Partial<Settings>;
    cache = sane(parsed);
    cacheMtime = mtime;
  } catch (err) {
    log.warn(`设置读取失败，用默认值: ${(err as Error).message}`);
    cache = DEFAULTS;
  }
  return cache;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = sane({ ...getSettings(), ...patch });
  try {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
    cacheMtime = fs.statSync(FILE).mtimeMs;
    cache = next;
    fs.mkdirSync(next.mediaCacheDir, { recursive: true });
    fs.mkdirSync(next.downloadDir, { recursive: true });
    log.info(`设置已更新：缓存目录=${next.mediaCacheDir} 上限=${next.mediaCacheMB}MB`);
  } catch (err) {
    log.warn(`设置写入失败: ${(err as Error).message}`);
  }
  return next;
}

/** 缓存目录（每次都现取，改了设置立刻生效）。 */
export function mediaDir(): string {
  const dir = getSettings().mediaCacheDir;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function mediaCacheLimitBytes(): number {
  return getSettings().mediaCacheMB * 1024 * 1024;
}
