/**
 * 直播式"边解密边封装"：把上游的 CENC(HEVC) 源实时解出来，转成 fMP4 直接推给浏览器。
 *
 * 电脑端直接把上游 URL 交给 ffmpeg；独立 APK 里的 ffmpeg 是精简版（不带 TLS），
 * 所以先用 Node 把加密原件落到手机缓存，再让 ffmpeg 读本地文件。两条路最终都一样：
 * 解密 + 重封装成 fMP4，不重编码。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type http from 'node:http';
import path from 'node:path';
import { download, findFfmpeg } from './transcode.ts';
import type { StreamChoice } from '../sources/playback.ts';
import { mediaDir } from '../store/settings.ts';
import { createLogger } from '../util/log.ts';

const log = createLogger('live');

/** ffmpeg 输出 fMP4 需要的参数：空 moov + 每个关键帧一个 fragment */
const FRAG_FLAGS = 'frag_keyframe+empty_moov+default_base_moof';

function writeHeaders(res: http.ServerResponse): void {
  if (res.headersSent) return;
  res.writeHead(200, {
    'content-type': 'video/mp4',
    'cache-control': 'no-store',
    // 不支持 Range：拖动由"后台落盘完成后换源"来解决
    'accept-ranges': 'none',
  });
}

/**
 * 把一集的加密源实时转成 fMP4 写进 HTTP 响应。
 * 客户端断开时杀掉 ffmpeg，避免泄漏。
 */
export function streamLiveMp4(stream: StreamChoice, res: http.ServerResponse): void {
  if (stream.url === '') {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('上游没有播放地址');
    return;
  }
  writeHeaders(res);
  if (process.env.HORUN_LIVE_LOCAL === '1') {
    void streamFromLocalFile(stream, res);
    return;
  }
  startFfmpeg(stream.url, stream, res, () => undefined);
}

/**
 * 独立 APK 路径：先下载到手机缓存，再交给 ffmpeg。
 * 缓存文件是临时的，客户端断开或 ffmpeg 结束就删，不占长期空间。
 */
async function streamFromLocalFile(stream: StreamChoice, res: http.ServerResponse): Promise<void> {
  const safe = stream.definition.replace(/[^0-9a-zA-Z]/g, '') || 'auto';
  const encPath = path.join(
    mediaDir(),
    `.live-${stream.episodeId}-${safe}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}.enc.mp4`,
  );
  const controller = new AbortController();
  let cleaned = false;
  const cleanupFile = (): void => {
    if (cleaned) return;
    cleaned = true;
    void fsp.rm(encPath, { force: true }).catch(() => undefined);
  };
  res.on('close', () => {
    controller.abort();
    cleanupFile();
  });

  try {
    fs.mkdirSync(mediaDir(), { recursive: true });
    await download(stream.url, encPath, () => undefined, controller.signal);
    if (controller.signal.aborted || res.destroyed) {
      cleanupFile();
      return;
    }
    log.info(`live 本地源已就绪：${path.basename(encPath)}`);
    startFfmpeg(encPath, stream, res, cleanupFile);
  } catch (err) {
    log.warn(`live 下载失败：${(err as Error).message}`);
    cleanupFile();
    if (!res.writableEnded) res.end();
  }
}

function startFfmpeg(
  input: string,
  stream: StreamChoice,
  res: http.ServerResponse,
  onDone: () => void,
): void {
  const ffmpeg = findFfmpeg();
  const args: string[] = ['-hide_banner', '-loglevel', 'error'];
  if (stream.protected && stream.decryptionKey !== '') {
    args.push('-decryption_key', stream.decryptionKey);
  }
  args.push('-i', input, '-c', 'copy', '-movflags', FRAG_FLAGS, '-f', 'mp4', 'pipe:1');

  let child: ChildProcess | null = null;
  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (child !== null && child.exitCode === null) {
      try {
        child.kill();
      } catch {
        /* 已经退出 */
      }
    }
    onDone();
  };

  try {
    child = spawn(ffmpeg, args, { windowsHide: true });
  } catch (err) {
    log.warn(`live 启动 ffmpeg 失败：${(err as Error).message}`);
    cleanup();
    if (!res.writableEnded) res.end();
    return;
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    if (!res.writableEnded) res.write(chunk);
  });
  child.stderr?.on('data', (data: Buffer) => {
    const text = String(data).trim();
    if (text !== '') log.debug(`ffmpeg: ${text.slice(0, 200)}`);
  });
  child.on('error', (err) => {
    log.warn(`live ffmpeg 错误：${err.message}`);
    cleanup();
    if (!res.writableEnded) res.end();
  });
  child.on('close', (code) => {
    if (code !== 0 && !closed) log.debug(`live ffmpeg 退出 code=${code}`);
    cleanup();
    if (!res.writableEnded) res.end();
  });

  res.on('close', cleanup);
  res.on('error', cleanup);
}
