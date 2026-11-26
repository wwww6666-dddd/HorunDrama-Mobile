/**
 * 转码：下载加密原件 → 用解密 key 交给 ffmpeg → 输出可在窗口里直接播的 H.264 mp4。
 *
 * 为什么要转：App 源是 HEVC(hvc1) + CENC-AES-CTR，Chromium 直接放不了；
 * 旧版验证过 `ffmpeg -decryption_key <hex> -i enc.mp4` 这条路可行，这里沿用同样的思路。
 *
 * 进度设计：下载 0~0.45，转码 0.45~0.99，完成 1。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { StreamChoice } from '../sources/playback.ts';
import { mediaDir, type EnhanceLevel } from '../store/settings.ts';
import { createLogger } from '../util/log.ts';

const log = createLogger('transcode');

/**
 * 正在写的产物文件（outPath → 完成信号）。
 * 两个 ffmpeg 同时写同一个 .part.mp4 会拼出"两个 moov"的坏 mp4：
 * 大小/时长都对，浏览器却解码失败，表现就是"切到下一集直接播放失败"。
 */
const WRITING = new Map<string, Promise<void>>();



const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** ffmpeg 位置：开发时用仓库里的，打包后在 resources 下，最后退回 PATH。 */
export function findFfmpeg(): string {
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath ?? '';
  const candidates = [
    process.env.HORUN_FFMPEG ?? '',
    resourcesPath === '' ? '' : path.join(resourcesPath, 'ffmpeg', 'ffmpeg.exe'),
    path.resolve(import.meta.dirname, '../../../desktop/resources/ffmpeg/ffmpeg.exe'),
    path.resolve(import.meta.dirname, '../../../../apps/desktop/resources/ffmpeg/ffmpeg.exe'),
    path.resolve(import.meta.dirname, '../../resources/ffmpeg/ffmpeg.exe'),
    'D:\\红果短剧\\apps\\desktop\\resources\\ffmpeg\\ffmpeg.exe',
  ].filter((p) => p !== '');
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* 继续找 */
    }
  }
  return 'ffmpeg';
}

export interface TranscodeProgress {
  progress: number;
  message: string;
}

export function mediaPathFor(
  episodeId: string,
  definition: string,
  enhance: EnhanceLevel = 'off',
  /** 搬运（不重编码）出来的 HEVC 版本单独存一份，避免给不能硬解 HEVC 的客户端播到 */
  hevcCopy = false,
): string {
  const safe = definition.replace(/[^0-9a-zA-Z]/g, '');
  const suffix = enhance === 'off' ? '' : `-${enhance}`;
  const variant = hevcCopy ? '-hevc' : '';
  return path.join(mediaDir(), `${episodeId}-${safe}${suffix}${variant}.mp4`);
}

function isManagedMediaFile(name: string): boolean {
  return /^\d{8,25}-[0-9a-z]+(?:-(?:standard|strong))?(?:-hevc)?\.mp4(?:\.(?:part|enc)\.mp4)?$/i.test(name);
}

/**
 * 找这一集已经转好的文件（不限定清晰度）。
 *
 * 为什么需要：`auto` 不该为了"先知道上游有哪些档位"再发一次取流请求——
 * 只要本地已经有一档转好的文件，就能立刻播；这也是 App 源不可用时唯一能救回
 * 高清播放的路径（之前转过的集照样能看）。
 */
export function existingMediaAny(
  episodeId: string,
  enhance: EnhanceLevel = 'off',
  allowHevc = false,
): { file: string; definition: string } | null {
  const suffix = enhance === 'off' ? '' : `-${enhance}`;
  const prefix = `${episodeId}-`;
  let names: string[];
  try {
    names = fs.readdirSync(mediaDir());
  } catch {
    return null;
  }
  let best: { file: string; definition: string; rank: number } | null = null;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(`${suffix}.mp4`)) continue;
    let middle = name.slice(prefix.length, name.length - `${suffix}.mp4`.length);
    // 搬运出来的 HEVC 版本带 -hevc 后缀；客户端不能硬解时直接跳过
    const isHevc = middle.endsWith('-hevc');
    if (isHevc) {
      if (!allowHevc) continue;
      middle = middle.slice(0, -'-hevc'.length);
    }
    if (middle === '' || /[^0-9a-zA-Z]/.test(middle)) continue;
    const full = path.join(mediaDir(), name);
    if (!usableMedia(full)) continue;
    const rank = Number.parseInt(/(\d+)/.exec(middle)?.[1] ?? '0', 10);
    if (best === null || rank > best.rank) best = { file: full, definition: middle, rank };
  }
  if (best === null) return null;
  return { file: best.file, definition: best.definition };
}

/** 画质增强的 ffmpeg 滤镜链：轻度降噪 + 亮度锐化（这个 2018 版 ffmpeg 没有 cas）。 */
const ENHANCE_FILTERS: Record<Exclude<EnhanceLevel, 'off'>, string> = {
  standard: 'hqdn3d=1.5:1.5:6:6,unsharp=5:5:0.7:5:5:0.0',
  strong: 'hqdn3d=2:2:8:8,unsharp=5:5:1.1:5:5:0.2',
};

/**
 * 编码器候选。
 *
 * 注意这台机器上打包的 ffmpeg 是 2018 版（N-92722）：它自带 NVENC，但用的是旧
 * NVENC SDK，和现在驱动（RTX 4060 / 32.x）对不上，一开就
 * "Cannot get the preset configuration: unsupported param"。所以不能只看
 * `ffmpeg -encoders` 里有没有，必须**真的试编一帧**再决定。
 *
 * 实测（720p×143s 的 HEVC 源）：
 *   libx264 veryfast crf23 → ~6.7s / 24.9MB   ← 当前唯一稳定可用
 *   h264_qsv                → ~10.5s（比 x264 还慢，不采用）
 *   h264_amf                → amfrt64.dll 缺失
 */
interface EncoderSpec {
  name: string;
  args: (crf: string) => string[];
}

const NATIVE_ENCODER: EncoderSpec = {
  name: 'libx264',
  args: (crf) => ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', crf, '-pix_fmt', 'yuv420p'],
};

const HW_ENCODERS: EncoderSpec[] = [
  {
    name: 'h264_nvenc',
    // 旧 NVENC API 的 preset 是 slow/medium/hp/hq…，不是 p1~p7
    args: (crf) => ['-c:v', 'h264_nvenc', '-preset', 'hp', '-rc', 'vbr', '-cq', crf, '-b:v', '0', '-pix_fmt', 'yuv420p'],
  },
  {
    name: 'h264_amf',
    args: (crf) => [
      '-c:v', 'h264_amf',
      '-quality', 'balanced',
      '-rc', 'cqp',
      '-qp_i', crf,
      '-qp_p', crf,
      '-pix_fmt', 'yuv420p',
    ],
  },
];

let encoderPromise: Promise<EncoderSpec> | null = null;

/** 用一帧纯色真实试编一次；能出码才算这个编码器可用。 */
function probeEncoder(ffmpeg: string, spec: EncoderSpec): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      ffmpeg,
      [
        '-hide_banner', '-v', 'error',
        '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.2',
        ...spec.args('23'),
        '-frames:v', '2',
        '-f', 'null', '-',
      ],
      { windowsHide: true },
    );
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
      finish(false);
    }, 8_000).unref?.();
  });
}

async function detectEncoder(): Promise<EncoderSpec> {
  encoderPromise ??= (async () => {
    const ffmpeg = findFfmpeg();
    for (const spec of HW_ENCODERS) {
      if (await probeEncoder(ffmpeg, spec)) {
        log.info(`编码器：使用 ${spec.name}`);
        return spec;
      }
      log.info(`编码器：${spec.name} 在这台机器上不可用，试下一个`);
    }
    if (await probeEncoder(ffmpeg, NATIVE_ENCODER)) {
      log.info('编码器：使用 libx264');
      return NATIVE_ENCODER;
    }
    throw new Error('内置 ffmpeg 没有可用的 H.264 编码器');
  })();
  return encoderPromise;
}

/** 不能硬解 HEVC 的手机上，先确认内置 ffmpeg 真能编 H.264，再决定要不要起高清任务。 */
export async function canEncodeH264(): Promise<boolean> {
  return detectEncoder().then(
    () => true,
    () => false,
  );
}

/**
 * 直接搬运（不重编码）。
 *
 * - H.264/AAC 源：一集 1~2 秒，画质零损失（一直如此）；
 * - HEVC 源：只有在客户端明确说自己能硬解 HEVC 时（Electron 的 Chromium 能）才搬运，
 *   省掉整个 x264 重编码（1080p 从 ~10 秒降到 ~1.5 秒），画质也零损失。
 *   ByteVC2（H.266/VVC）永远不搬运，浏览器解不了。
 */
function canRemux(codec: string, allowHevc = false): boolean {
  const name = codec.trim().toLowerCase();
  if (/^(h264|avc1|avc|h\.264)$/.test(name)) return true;
  if (!allowHevc) return false;
  if (name === 'bytevc2' || name === 'vvc' || name === 'h266') return false;
  return /^(hevc|hvc1|hev1|bytevc1|h\.265)$/.test(name);
}

/** 只允许取 media 目录下的单层文件名，防目录穿越。 */
export function mediaFilePath(name: string): string | null {
  const base = path.basename(name);
  if (base !== name || !base.endsWith('.mp4')) return null;
  const full = path.join(mediaDir(), base);
  try {
    return fs.statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

/** 已转好且非空就直接复用，省掉一次几分钟的转码。 */
export function existingMedia(
  episodeId: string,
  definition: string,
  enhance: EnhanceLevel = 'off',
  allowHevc = false,
): string | null {
  if (allowHevc) {
    const hevc = mediaPathFor(episodeId, definition, enhance, true);
    if (usableMedia(hevc)) return hevc;
  }
  const file = mediaPathFor(episodeId, definition, enhance);
  if (usableMedia(file)) return file;
  return null;
}

/**
 * 缓存文件能不能直接用。
 *
 * 只看"大小 > 1KB"不够：曾经出现过两个任务同时写同一个 `.part.mp4`，拼出一个
 * "有 mvhd、但里面有两个 moov"的文件 —— 大小和时长校验都能过，浏览器却直接
 * PipelineStatus::PIPELINE_ERROR_DECODE。这里顺手把它删掉，下次重转，能自愈。
 */
function usableMedia(file: string): boolean {
  try {
    if (fs.statSync(file).size <= 1024) return false;
  } catch {
    return false;
  }
  if (mp4IsSane(file)) return true;
  log.warn(`缓存文件结构损坏，删除重转：${path.basename(file)}`);
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* 删不掉也不影响：这次判失败，调用方会重新转码到 .part 再改名 */
  }
  return false;
}

export async function download(
  url: string,
  dest: string,
  onProgress: (p: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: '*/*' },
    signal: signal ?? AbortSignal.timeout(120_000),
  });
  if (!res.ok || res.body === null) throw new Error(`下载失败 HTTP ${res.status}`);
  const total = Number.parseInt(res.headers.get('content-length') ?? '0', 10);

  const handle = await fsp.open(dest, 'w');
  let received = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      if (signal?.aborted === true) throw new Error('已取消');
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        await handle.write(value);
        received += value.byteLength;
        if (total > 0) onProgress(Math.min(1, received / total));
      }
    }
  } finally {
    await handle.close();
  }
  // 上游偶尔会提前关门：不校验的话会拿半截文件去转码，产出一个"能播但只有几秒"的缓存，
  // 观众看到的是一集刚开始就结束（然后弹"重播"）。
  if (total > 0 && received < total - 1024) {
    throw new Error(`下载不完整：${received}/${total} 字节`);
  }
  if (received < 1024) throw new Error('下载内容为空');
}

/** 读 mp4 的 mvhd 时长（秒）；解析不出来返回 0。 */
export function mp4DurationSec(file: string): number {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const head = Buffer.alloc(Math.min(size, 1 << 20));
      fs.readSync(fd, head, 0, head.length, 0);
      const idx = head.indexOf('mvhd');
      if (idx < 0) return 0;
      const version = head[idx + 4];
      if (version === 1) {
        const timescale = head.readUInt32BE(idx + 8 + 16);
        const duration = Number(head.readBigUInt64BE(idx + 8 + 20));
        return timescale > 0 ? duration / timescale : 0;
      }
      const timescale = head.readUInt32BE(idx + 8 + 8);
      const duration = head.readUInt32BE(idx + 8 + 12);
      return timescale > 0 ? duration / timescale : 0;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 0;
  }
}

/**
 * mp4 结构是否可信：走一遍顶层 box，要求 moov 只有一个、mdat 存在、每个 box
 * 的边界都落在文件内。
 *
 * 抓到过的坏样本："两个 moov"（并发写同一个文件）和被上游掐断的截断文件。
 * 这类文件 mvhd 时长正常，播放器却直接解码失败，所以必须在复用前挡掉。
 */
export function mp4IsSane(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const head = Buffer.alloc(16);
      let offset = 0;
      let moov = 0;
      let mdat = 0;
      for (let guard = 0; guard < 64; guard += 1) {
        if (offset >= size) break;
        if (offset + 8 > size) return false;
        fs.readSync(fd, head, 0, 16, offset);
        let boxSize = head.readUInt32BE(0);
        const type = head.toString('latin1', 4, 8);
        let headerSize = 8;
        if (boxSize === 1) {
          if (offset + 16 > size) return false;
          boxSize = Number(head.readBigUInt64BE(8));
          headerSize = 16;
        } else if (boxSize === 0) {
          boxSize = size - offset;
        }
        if (boxSize < headerSize || offset + boxSize > size) return false;
        if (type === 'moov') moov += 1;
        else if (type === 'mdat') mdat += 1;
        offset += boxSize;
      }
      return moov === 1 && mdat >= 1 && offset === size;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * 把 .part.mp4 落成正式文件名。
 * Windows 上 ffmpeg 刚退出时句柄/杀软扫描可能还没松开，rename 会偶发
 * EBUSY/EPERM。这里重试几次，最后退化成"复制 + 删临时文件"。
 */
async function commitFile(from: string, to: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') throw err;
      if (attempt === 7) {
        await fsp.copyFile(from, to);
        await fsp.rm(from, { force: true });
        return;
      }
      await new Promise((r) => setTimeout(r, 150 + attempt * 150));
    }
  }
}

function runFfmpeg(
  ffmpeg: string,
  args: string[],
  durationSec: number,
  onProgress: (p: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    let errorTail = '';
    const onAbort = (): void => {
      child.kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    // 不依赖 `-progress pipe:1`：部分精简版 ffmpeg 没编 pipe 协议，
    // 会在启动时直接报 "Protocol not found"。默认 stderr 的 `time=` 统计
    // 所有构建都有，用它推进度；只保留非统计行给失败信息。
    const consumeLine = (raw: string): void => {
      const line = raw.trim();
      if (line === '') return;
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
      if (m !== null && durationSec > 0) {
        const done =
          Number.parseInt(m[1] ?? '0', 10) * 3600 +
          Number.parseInt(m[2] ?? '0', 10) * 60 +
          Number.parseFloat(m[3] ?? '0');
        onProgress(Math.max(0, Math.min(1, done / durationSec)));
        return;
      }
      if (/^(frame=|fps=|size=|bitrate=|speed=|out_time=|dup_frames=|drop_frames=|progress=)/.test(line)) {
        return;
      }
      errorTail = (errorTail + raw + '\n').slice(-2000);
    };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r|\n/)) consumeLine(line);
    });
    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted === true) reject(new Error('已取消'));
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg 退出码 ${String(code)}：${errorTail.slice(-400)}`));
    });
  });
}

/**
 * 转一集：返回可播放文件路径。
 * 同一集并发进来由上层 job 层做单飞；这里再加一道保险：同一份产物只许一个
 * ffmpeg 写（并发写同一个 .part.mp4 会产出结构损坏的 mp4）。
 */
export async function transcodeEpisode(
  stream: StreamChoice,
  onProgress: (p: TranscodeProgress) => void,
  signal?: AbortSignal,
  enhance: EnhanceLevel = 'off',
  /** 客户端能硬解 HEVC：源是 HEVC 时直接解密+搬运，不重编码 */
  allowHevcCopy = false,
): Promise<string> {
  const hevcCopy =
    allowHevcCopy && enhance === 'off' && /^(hevc|hvc1|hev1|bytevc1|h\.265)$/i.test(stream.codec.trim());
  const outPath = mediaPathFor(stream.episodeId, stream.definition, enhance, hevcCopy);

  const cached = existingMedia(stream.episodeId, stream.definition, enhance, allowHevcCopy);
  if (cached !== null) {
    onProgress({ progress: 1, message: '已缓存' });
    return cached;
  }

  if (stream.url === '') throw new Error('上游没有播放地址');

  // 同一份产物已经有任务在写：等它结束，成了就复用，不成就自己再来一次
  const busy = WRITING.get(outPath);
  if (busy !== undefined) {
    await busy;
    const again = existingMedia(stream.episodeId, stream.definition, enhance, allowHevcCopy);
    if (again !== null) {
      onProgress({ progress: 1, message: '已缓存' });
      return again;
    }
  }

  // 中间文件跟着产物名走：同一集不同档位同时转也不会互删
  const encPath = path.join(mediaDir(), `${path.basename(outPath)}.enc.mp4`);
  // 先写 .part.mp4 再改名：ffmpeg 靠扩展名猜封装格式，必须保留 .mp4 后缀；
  // 中断时也不会留下一个"看起来有效"的半截 mp4 污染缓存
  const tmpOut = `${outPath}.part.mp4`;

  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  WRITING.set(outPath, gate);

  try {
    onProgress({ progress: 0, message: '下载加密原件' });
    await download(
      stream.url,
      encPath,
      (p) => {
        onProgress({ progress: p * 0.45, message: `下载 ${Math.round(p * 100)}%` });
      },
      signal,
    );

    const ffmpeg = findFfmpeg();
    const crf = enhance === 'off' ? '23' : '21';
    const vf = enhance === 'off' ? [] : ['-vf', ENHANCE_FILTERS[enhance]];
    // 源本来就是 H.264（且没要求画质增强）→ 只解密 + 重封装，不重编码：
    // 一集 720p 从 6.7s 降到 1.4s，而且画质零损失。
    const remux = enhance === 'off' && (canRemux(stream.codec) || hevcCopy);

    const buildArgs = (encoder: EncoderSpec): string[] => {
      const args: string[] = ['-y'];
      if (stream.protected && stream.decryptionKey !== '') {
        args.push('-decryption_key', stream.decryptionKey);
      }
      if (remux) {
        args.push('-i', encPath, '-c', 'copy', '-movflags', '+faststart', tmpOut);
        return args;
      }
      args.push(
        '-i',
        encPath,
        ...vf,
        ...encoder.args(crf),
        '-c:a',
        'aac',
        '-b:a',
        '96k',
        '-movflags',
        '+faststart',
        tmpOut,
      );
      return args;
    };

    if (enhance !== 'off') log.info(`画质增强=${enhance} 滤镜=${ENHANCE_FILTERS[enhance]}`);

    onProgress({ progress: 0.45, message: remux ? '解密封装中' : '转码中' });
    // 纯搬运（copy）不需要任何编码器。以前这里无条件调 detectEncoder，
    // 在没有 libx264/硬编的 Android 包上会先抛“没有 H.264 编码器”，
    // 导致明明能硬解 HEVC 的 1080p 也被误判失败，只剩 360p。
    let encoder = remux ? NATIVE_ENCODER : await detectEncoder();
    const runEncode = async (spec: EncoderSpec): Promise<void> => {
      await runFfmpeg(
        ffmpeg,
        buildArgs(spec),
        stream.durationSec,
        (p) => {
          onProgress({ progress: 0.45 + p * 0.54, message: remux ? '解密封装中' : `转码 ${Math.round(p * 100)}%` });
        },
        signal,
      );
    };
    try {
      await runEncode(encoder);
    } catch (err) {
      // 硬件编码器可能"查得到但跑不动"（驱动/会话占用），退回 libx264 再来一次
      if (remux || encoder.name === NATIVE_ENCODER.name || signal?.aborted === true) throw err;
      log.warn(`${encoder.name} 编码失败，退回 libx264：${(err as Error).message.slice(0, 200)}`);
      encoder = NATIVE_ENCODER;
      encoderPromise = Promise.resolve(NATIVE_ENCODER);
      await fsp.rm(tmpOut, { force: true }).catch(() => undefined);
      await runEncode(NATIVE_ENCODER);
    }

    // 产物时长校验：源和被掐断的下载都可能让 ffmpeg 只解出前几秒。
    // 这里比对两者的 mvhd 时长，差得太多就判失败（不留坏缓存，下次重下重转）。
    const srcDur = mp4DurationSec(encPath);
    const outDur = mp4DurationSec(tmpOut);
    if (outDur < 3 || (srcDur > 5 && outDur < srcDur - 3)) {
      await fsp.rm(tmpOut, { force: true }).catch(() => undefined);
      throw new Error(
        `产物时长异常：源 ${srcDur.toFixed(1)}s / 产物 ${outDur.toFixed(1)}s（可能是下载不完整）`,
      );
    }
    // 结构校验：两个进程同时写、上游中途掐断都可能拼出"两个 moov"或截断的 mp4，
    // 这种文件时长正常、浏览器解码却直接失败，绝不能进缓存
    if (!mp4IsSane(tmpOut)) {
      await fsp.rm(tmpOut, { force: true }).catch(() => undefined);
      throw new Error('产物结构异常（moov 缺失或重复），已丢弃，下次重转');
    }

    onProgress({ progress: 1, message: '就绪' });
    await commitFile(tmpOut, outPath);
    log.info(`转码完成 ${stream.episodeId}（${remux ? 'copy' : encoder.name}，${outDur.toFixed(1)}s）`);
    return outPath;
  } finally {
    WRITING.delete(outPath);
    release();
    void fsp.rm(encPath, { force: true }).catch(() => undefined);
    void fsp.rm(tmpOut, { force: true }).catch(() => undefined);
  }
}

/** 按字节上限清理最旧的转码产物（按 mtime）。 */
export async function pruneMediaCache(limitBytes: number): Promise<void> {
  try {
    const dir = mediaDir();
    const names = await fsp.readdir(dir);
    const files = await Promise.all(
      names
        .filter(isManagedMediaFile)
        .map(async (n) => {
          const p = path.join(dir, n);
          const st = await fsp.stat(p);
          return { p, size: st.size, mtime: st.mtimeMs };
        }),
    );
    let total = files.reduce((s, f) => s + f.size, 0);
    if (total <= limitBytes) return;
    files.sort((a, b) => a.mtime - b.mtime);
    for (const f of files) {
      if (total <= limitBytes) break;
      await fsp.rm(f.p, { force: true }).catch(() => undefined);
      total -= f.size;
    }
  } catch {
    /* 缓存清理失败不影响播放 */
  }
}

/** 缓存占用（只统计 .mp4；.enc 是转码中间文件，转完就删）。 */
export async function mediaCacheStats(): Promise<{ dir: string; count: number; bytes: number }> {
  const dir = mediaDir();
  let count = 0;
  let bytes = 0;
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  for (const n of names) {
    if (!isManagedMediaFile(n)) continue;
    try {
      const st = await fsp.stat(path.join(dir, n));
      count += 1;
      bytes += st.size;
    } catch {
      /* 跳过读不到的 */
    }
  }
  return { dir, count, bytes };
}

/** 清理应用生成的转码缓存文件；不触碰目录和用户放在缓存目录中的其他文件。 */
export async function clearMediaCache(): Promise<{ removed: number; bytes: number }> {
  const dir = mediaDir();
  let removed = 0;
  let bytes = 0;
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  for (const n of names) {
    const p = path.join(dir, n);
    try {
      if (!isManagedMediaFile(n)) continue;
      const st = await fsp.lstat(p);
      if (!st.isFile()) continue;
      await fsp.rm(p, { force: true });
      removed += 1;
      bytes += st.size;
    } catch {
      /* 单个失败不影响整体 */
    }
  }
  return { removed, bytes };
}
