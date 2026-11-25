/**
 * 播放计划：一集到底怎么播。
 *
 * 历史包袱：App 源（SDK video_model）是 HEVC + CENC，浏览器放不了，只能
 * 「整集下载 → ffmpeg 转码 → 播本地文件」。一集要几十秒，用户反馈「太卡」；
 * 而 2026-11-16 傍晚起 App 源还对匿名设备稳定返回空 body，于是永远
 * 「上游没有可播放的清晰度」。
 *
 * 现在的策略（快路径优先）：
 *  1. 本地已经有转好的文件（任意清晰度）→ 直接播本地，不发任何上游请求；
 *  2. 否则取官网 H5 的 360p 直连 mp4（H.264/AAC、不加密、可 Range）→ 秒开；
 *  3. 需要高清时，在后台跑 App 源的转码任务（job），转好了由前端无缝换源。
 *
 * 所以 `/api/play` 可能立刻返回：
 *  - mode=file   ：本地文件（缓存命中或转码完成）
 *  - mode=direct ：上游 CDN 直连地址（秒开，可拖动）
 * 并且可能带 upgradeJobId，表示"高清正在后台准备"。
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { resolveEpisodeStream, type StreamChoice } from '../sources/playback.ts';
import { resolveWebStream } from '../sources/webplay.ts';
import {
  existingMedia,
  existingMediaAny,
  mediaPathFor,
  pruneMediaCache,
  transcodeEpisode,
} from './transcode.ts';
import { getSettings, mediaCacheLimitBytes, type EnhanceLevel } from '../store/settings.ts';
import { createLogger } from '../util/log.ts';

const log = createLogger('jobs');

export type JobState = 'queued' | 'working' | 'ready' | 'failed';
/** file=本地 mp4；direct=上游 CDN 直连 */
export type JobMode = 'file' | 'direct';

export interface Job {
  id: string;
  episodeId: string;
  definition: string;
  quality: string;
  available: string[];
  state: JobState;
  progress: number;
  message: string;
  mode: JobMode;
  /** mode=file 时的本地文件名 */
  file: string;
  /** mode=direct 时的完整 CDN 地址 */
  directUrl: string;
  /** 后台高清任务的 id（前端轮询它，ready 后换源） */
  upgradeJobId: string;
  upgradeQuality: string;
  durationSec: number;
  error: string;
  createdAt: number;
  /** 前台任务（用户在等这一集），转码时优先，不和后台预加载一起抢 CPU */
  foreground?: boolean;
}

const JOBS = new Map<string, Job>();
/** 同一集同档并发请求合并成一次转码（存的是那个"还没建好 job"的 promise） */
const INFLIGHT = new Map<string, Promise<Job>>();

const MAX_JOBS = 60;
const CACHE_LIMIT = mediaCacheLimitBytes();

/** 前端可选的清晰度；smooth 是官网 360p 直连 */
export const QUALITY_CHOICES = ['smooth', '480p', '720p', '1080p'];

function isHd(q: string): boolean {
  return q === '480p' || q === '720p' || q === '1080p';
}

function trimJobs(): void {
  if (JOBS.size <= MAX_JOBS) return;
  const sorted = [...JOBS.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const job of sorted.slice(0, JOBS.size - MAX_JOBS)) {
    if (job.state === 'working' || job.state === 'queued') continue;
    JOBS.delete(job.id);
  }
}

export function getJob(id: string): Job | undefined {
  return JOBS.get(id);
}

export function jobView(job: Job): {
  jobId: string;
  mode: JobMode;
  state: JobState;
  progress: number;
  message: string;
  url: string;
  durationSec: number;
  definition: string;
  available: string[];
  upgradeJobId: string;
  upgradeQuality: string;
  error: string;
} {
  return {
    jobId: job.id,
    mode: job.mode,
    state: job.state,
    progress: Math.round(job.progress * 100) / 100,
    message: job.message,
    url:
      job.state !== 'ready'
        ? ''
        : job.mode === 'direct'
          ? job.directUrl
          : `/api/media/${encodeURIComponent(job.file)}`,
    durationSec: job.durationSec,
    definition: job.definition,
    available: job.available,
    upgradeJobId: job.upgradeJobId,
    upgradeQuality: job.upgradeQuality,
    error: job.error,
  };
}

function newJob(partial: Omit<Job, 'id' | 'createdAt' | 'upgradeJobId' | 'upgradeQuality'>): Job {
  const job: Job = {
    ...partial,
    id: crypto.randomBytes(8).toString('hex'),
    upgradeJobId: '',
    upgradeQuality: '',
    createdAt: Date.now(),
  };
  JOBS.set(job.id, job);
  trimJobs();
  return job;
}

function readyFileJob(
  episodeId: string,
  file: string,
  definition: string,
  quality: string,
  message: string,
): Job {
  return newJob({
    episodeId,
    definition,
    quality,
    available: QUALITY_CHOICES,
    state: 'ready',
    progress: 1,
    message,
    mode: 'file',
    file: path.basename(file),
    directUrl: '',
    durationSec: 0,
    error: '',
  });
}

function readyDirectJob(episodeId: string, quality: string, message: string): Job {
  return newJob({
    episodeId,
    definition: '流畅 360p',
    quality,
    available: QUALITY_CHOICES,
    state: 'ready',
    progress: 1,
    message,
    mode: 'direct',
    file: '',
    // 不直接把 CDN 地址给 <video>：CDN 对浏览器的 Referer 回 403，
    // 走 core 代理（同源 + 保留 Range），地址过期也能在代理层重取
    directUrl: `/api/stream/${encodeURIComponent(episodeId)}`,
    durationSec: 0,
    error: '',
  });
}

/** 秒开任务：直接给"边解密边播"的地址，后台同时落一份完整缓存 */
function readyLiveJob(episodeId: string, quality: string, definition: string, durationSec: number): Job {
  return newJob({
    episodeId,
    definition,
    quality,
    available: QUALITY_CHOICES,
    state: 'ready',
    progress: 1,
    message: '秒开（后台缓存完整版）',
    mode: 'direct',
    file: '',
    directUrl: `/api/live/${encodeURIComponent(episodeId)}?quality=${encodeURIComponent(quality)}`,
    durationSec,
    error: '',
  });
}

/**
 * 起一个 App 源转码任务（或复用已有的）。返回的 job 可能已经在跑/已缓存。
 * 取流失败时抛错，由调用方决定退化路径。
 *
 * 去重要点：占位必须**同步**放进 INFLIGHT。早先是「先 await 取流、再写 INFLIGHT」，
 * 同一集的两个请求（页面自己起播 + 预加载/pull-upgrade）会同时通过检查、各起一个
 * ffmpeg 写同一个 `.part.mp4` → 产物里出现两个 moov，浏览器解码直接报
 * PipelineStatus::PIPELINE_ERROR_DECODE，表现为"自动切到下一集就播放失败"。
 */
async function startAppJob(
  episodeId: string,
  quality: string,
  reuseInflight: boolean,
  allowHevc = false,
  /** 前台任务：用户在等这一集（等文件再播），转码时不让后台预加载跟它抢 CPU */
  foreground = false,
): Promise<Job> {
  const enhance = getSettings().enhanceVideo;
  const key = `${episodeId}|${quality}|${enhance}`;
  if (reuseInflight) {
    const running = INFLIGHT.get(key);
    if (running !== undefined) return running;
  }
  const pending = startAppJobInner(episodeId, quality, enhance, key, allowHevc, foreground);
  INFLIGHT.set(key, pending);
  return pending;
}

async function startAppJobInner(
  episodeId: string,
  quality: string,
  enhance: EnhanceLevel,
  key: string,
  allowHevc: boolean,
  foreground: boolean,
): Promise<Job> {
  try {
    const stream = await resolveEpisodeStream(episodeId, quality, 1);
    if (stream === null) throw new Error('上游暂时取不到这一集的播放地址');

    const cached = existingMedia(episodeId, stream.definition, enhance, allowHevc);
    const job = newJob({
      episodeId,
      definition: stream.definition,
      quality,
      available: QUALITY_CHOICES,
      state: cached !== null ? 'ready' : 'queued',
      progress: cached !== null ? 1 : 0,
      message: cached !== null ? '已缓存' : '排队中',
      mode: 'file',
      file:
        cached !== null
          ? path.basename(mediaPathFor(episodeId, stream.definition, enhance, allowHevc))
          : '',
      directUrl: '',
      durationSec: stream.durationSec,
      error: '',
    });
    if (job.state === 'ready') {
      INFLIGHT.delete(key);
      return job;
    }
    job.foreground = foreground;
    // 占位留到转码结束（runTranscode 的 finally 里删）
    void runTranscode(job, stream, enhance, key, allowHevc);
    return job;
  } catch (err) {
    INFLIGHT.delete(key);
    throw err;
  }
}

/**
 * 转码闸门：前台（用户在等）不限；后台（预加载/预热/升档）必须等没有别的转码在跑，
 * 且一次只放一个。
 *
 * 为什么需要：开「画质增强」时一集 1080p 要 x264 + 降噪锐化（实测 ~80s），
 * 3 路 ffmpeg 一起跑会把 CPU 抢死 —— 用户看到的"正在准备这一集"从 80s 变成 3 分钟以上。
 */
let activeTranscodes = 0;
const backgroundWaiters: Array<() => void> = [];

async function acquireTranscode(foreground: boolean): Promise<void> {
  if (foreground) {
    activeTranscodes += 1;
    return;
  }
  while (activeTranscodes > 0) {
    await new Promise<void>((resolve) => backgroundWaiters.push(resolve));
  }
  activeTranscodes += 1;
}

function releaseTranscode(): void {
  activeTranscodes = Math.max(0, activeTranscodes - 1);
  if (activeTranscodes === 0) {
    const next = backgroundWaiters.shift();
    if (next !== undefined) next();
  }
}

async function runTranscode(
  job: Job,
  stream: StreamChoice,
  enhance: ReturnType<typeof getSettings>['enhanceVideo'],
  key: string,
  allowHevc = false,
): Promise<void> {
  const foreground = job.foreground === true;
  try {
    job.state = 'working';
    if (!foreground) job.message = '排队中转码…';
    await acquireTranscode(foreground);
    const file = await transcodeEpisode(
      stream,
      (p) => {
        job.progress = Math.max(job.progress, p.progress);
        job.message = p.message;
      },
      undefined,
      enhance,
      allowHevc,
    );
    job.file = path.basename(file);
    job.definition = stream.definition;
    job.state = 'ready';
    job.progress = 1;
    job.message = '就绪';
    void pruneMediaCache(CACHE_LIMIT);
  } catch (err) {
    job.state = 'failed';
    job.error = (err as Error).message;
    job.message = '转码失败';
    log.warn(`转码失败 ${stream.episodeId}: ${job.error}`);
  } finally {
    releaseTranscode();
    INFLIGHT.delete(key);
  }
}

/** 后台准备高清：失败只记日志，不影响正在播的流畅版。 */
async function startUpgrade(episodeId: string, quality: string, allowHevc = false): Promise<Job | null> {
  try {
    return await startAppJob(episodeId, quality, true, allowHevc);
  } catch (err) {
    log.info(`高清后台准备失败 ${episodeId}（${quality}）：${(err as Error).message}`);
    return null;
  }
}

/**
 * 只起高清任务，不动正在播的视频（前端定时重试用）。
 * 上游限流时返回 null，让调用方安静地等下一轮。
 */
export async function startUpgradeJob(
  episodeId: string,
  quality = '720p',
  allowHevc = false,
): Promise<Job | null> {
  const target = isHd(quality) ? quality : '720p';
  const cached = existingMedia(episodeId, target, getSettings().enhanceVideo, allowHevc);
  if (cached !== null) {
    return readyFileJob(episodeId, cached, target, target, '已缓存');
  }
  return startUpgrade(episodeId, target, allowHevc);
}

export interface StartOptions {
  /** 是否允许"先秒开、后台再升级到高清" */
  upgrade?: boolean;
  /** 客户端能硬解 HEVC：源是 HEVC 时只解密+搬运，不重编码（1080p 从 ~10s 降到 ~1.5s） */
  hevc?: boolean;
  /** 允许用"边解密边播"的秒开流（播放页用；推荐页滑动场景不走它） */
  live?: boolean;
  /**
   * 等文件：没有缓存时不要先给 360p 直连/秒开流，直接起 App 源任务让前端轮询进度。
   *
   * 播放页用这个（用户要求"等准备好再播"）：只有本地 mp4 才有完整时长和可拖动进度条；
   * 前后各 N 集的预加载会把后续集提前转好，正常追剧时基本不用等。
   */
  wait?: boolean;
}

/**
 * 后台升降清：**不阻塞** /api/play 的返回。
 *
 * 早先是 `await startUpgrade(...)`：App 源要解析签名/设备，正常 1~3s，
 * 上游匿名设备注册失败时（D-47）要 8s+ 才失败 —— 这段时间用户盯着"准备中"，
 * 秒开也就没意义了。现在先把 360p/已缓存低档返回，任务在后台跑；
 * 前端 `upgradeJobId` 没拿到就按 1.2s / 3min 的节奏自己来问（Play.tsx 里已有）。
 */
function attachUpgrade(job: Job, episodeId: string, target: string, allowHevc: boolean): void {
  void startUpgrade(episodeId, target, allowHevc)
    .then((hd) => {
      if (hd !== null) {
        job.upgradeJobId = hd.id;
        job.upgradeQuality = target;
      } else if (job.mode === 'direct') {
        job.message = `${target} 暂时取不到，先用流畅播放`;
      }
    })
    .catch(() => undefined);
}

/** 开始（或复用）一集的播放准备。返回立刻可见的 job。 */
export async function startEpisode(episodeId: string, quality = 'auto', options: StartOptions = {}): Promise<Job> {
  const want = quality === '' ? 'auto' : quality;
  const allowUpgrade = options.upgrade === true;
  const allowHevc = options.hevc === true;
  const allowLive = options.live === true;
  const waitFile = options.wait === true;

  // 1) 本地缓存优先：auto 命中任意清晰度，指定档位只命中同档
  if (want === 'auto') {
    const cached = existingMediaAny(episodeId, getSettings().enhanceVideo, allowHevc);
    if (cached !== null) {
      return readyFileJob(episodeId, cached.file, cached.definition, want, '已缓存');
    }
  } else if (isHd(want)) {
    const hit = existingMedia(episodeId, want, getSettings().enhanceVideo, allowHevc);
    if (hit !== null) return readyFileJob(episodeId, hit, want, want, '已缓存');
    // 目标档没缓存、但更低档有：先用已有的播，后台继续升到目标档
    const lower = existingMediaAny(episodeId, getSettings().enhanceVideo, allowHevc);
    if (lower !== null) {
      const job = readyFileJob(episodeId, lower.file, lower.definition, want, `先用已缓存的 ${lower.definition}`);
      if (allowUpgrade) attachUpgrade(job, episodeId, want, allowHevc);
      return job;
    }
    // 等文件（播放页）：没缓存就直接起 App 源任务，由前端轮询进度后再播。
    // 不先给 360p/秒开流 —— 用户明确要"完整时长 + 能拖进度条"的本地 mp4。
    // 起不来（上游限流等）才退回下面的 360p 直连，至少别卡死在"准备失败"。
    if (allowUpgrade && waitFile) {
      try {
        // reuseInflight=true：预加载/预热已经在对这一集转码时直接加入它，不要重复起一个
        // foreground=true：用户正在等，转码闸门给它优先权（后台预加载自动让路）
        return await startAppJob(episodeId, want, true, allowHevc, true);
      } catch (err) {
        log.info(`等高清失败，退流畅线路 ${episodeId}（${want}）：${(err as Error).message}`);
      }
    }
    // 不支持"后台升清"的场景（比如推荐页手动选高清）：直接起高清任务，
    // 这样它会走 App 源，而不是悄悄退回 360p
    if (!allowUpgrade) {
      try {
        return await startAppJob(episodeId, want, false, allowHevc);
      } catch (err) {
        log.info(`高清任务失败 ${episodeId}（${want}）：${(err as Error).message}`);
      }
    }
  }

  // 2) 快路径：官网 H5 的 360p 直连（H.264 明文，支持 Range）
  //    这是"能拖进度"的代价最小的选择：时长立刻可知、拖到哪播到哪；
  //    高清由后台任务转好后再无缝换源（换源保留播放位置）。
  if (want === 'auto' || want === 'smooth' || isHd(want)) {
    const web = await resolveWebStream(episodeId);
    if (web !== null) {
      const job = readyDirectJob(episodeId, want, '流畅播放（可拖动，高清后台准备中）');
      if (allowUpgrade && (want === 'auto' || isHd(want))) {
        const target = isHd(want) ? want : '720p';
        // 不 await：先把 360p 地址返回给前端起播，高清在后台起任务（见 attachUpgrade）
        attachUpgrade(job, episodeId, target, allowHevc);
      }
      return job;
    }
  }

  if (want === 'smooth') throw new Error('流畅线路暂时取不到地址，稍后再试');

  // 2.5) 官网直连也拿不到：退"秒开流"（fMP4 管道）。
  // 它没有完整时长、不能拖进度，所以只放在兜底位置，不再作为首选。
  if (isHd(want) && allowUpgrade && allowHevc && allowLive) {
    const live = readyLiveJob(episodeId, want, want, 0);
    live.upgradeQuality = want;
    void startUpgrade(episodeId, want, true).then((hd) => {
      if (hd !== null) live.upgradeJobId = hd.id;
    });
    return live;
  }

  // 3) 慢路径：App 源 + 转码（会等一段时间，但有 720p/1080p）
  try {
    return await startAppJob(episodeId, isHd(want) ? want : 'auto', false, allowHevc);
  } catch (err) {
    throw new Error(`上游暂时没有可播放的清晰度（可能被限流），请稍后再试：${(err as Error).message}`);
  }
}
