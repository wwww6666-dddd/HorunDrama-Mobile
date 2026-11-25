/**
 * 下载队列：转码产物落到「下载目录」，最多同时跑 2 集。
 *
 * 复用播放的转码管线：解密 → H.264 MP4（先转码、后改 CENC 直存，见方案 D3）。
 * 因此下载完的同一集，播放时也能直接命中缓存。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolveEpisodeStream, type StreamChoice } from '../sources/playback.ts';
import { resolveWebStream } from '../sources/webplay.ts';
import { transcodeEpisode } from './transcode.ts';
import { getSettings } from '../store/settings.ts';
import { safeName } from './safe-name.ts';
import { createLogger } from '../util/log.ts';
import {
  downloadSummary,
  getDownload,
  listDownloads,
  nextQueued,
  removeDownload,
  resetInterrupted,
  updateDownload,
  upsertQueued,
  type DownloadRow,
} from '../store/downloads.ts';

const log = createLogger('download');

const active = new Map<string, AbortController>();
let pumping = false;

resetInterrupted();

function qualitySuffix(definition: string): string {
  const clean = definition.replace(/[^0-9a-zA-Z]/g, '');
  return clean === '' ? '' : `-${clean}`;
}

/** 直连下载：官网 360p 的 mp4 是明文 H.264，不需要转码，直接落盘。 */
async function downloadDirect(
  url: string,
  dest: string,
  onProgress: (p: number) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0', accept: '*/*' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]),
  });
  if (!res.ok || res.body === null) throw new Error(`下载失败 HTTP ${res.status}`);
  const total = Number.parseInt(res.headers.get('content-length') ?? '0', 10);
  const handle = await fsp.open(dest, 'w');
  try {
    const reader = res.body.getReader();
    let received = 0;
    for (;;) {
      if (signal.aborted) throw new Error('已取消');
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        await handle.write(value);
        received += value.byteLength;
        if (total > 0) onProgress(Math.min(0.98, received / total));
      }
    }
  } finally {
    await handle.close();
  }
}

async function copyWithProgress(
  src: string,
  dest: string,
  onProgress: (p: number) => void,
  signal: AbortSignal,
): Promise<void> {
  const total = (await fsp.stat(src)).size;
  let done = 0;
  const probe = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      if (signal.aborted) {
        callback(new Error('已取消'));
        return;
      }
      done += chunk.length;
      if (total > 0) onProgress(Math.min(1, done / total));
      callback(null, chunk);
    },
  });
  await pipeline(fs.createReadStream(src), probe, fs.createWriteStream(dest));
}

async function run(row: DownloadRow): Promise<void> {
  const ctrl = new AbortController();
  active.set(row.id, ctrl);
  let part = '';

  try {
    const dir = path.join(getSettings().downloadDir, safeName(row.seriesTitle));
    await fsp.mkdir(dir, { recursive: true });

    // 先试 App 源（高清，走转码）；失败就退到官网 360p 直连，至少能下载成
    let stream: StreamChoice | null = null;
    try {
      stream = await resolveEpisodeStream(row.episodeId, getSettings().defaultQuality, 1);
    } catch (err) {
      log.info(`App 源取流失败，下载改用官网直连 ${row.episodeId}：${(err as Error).message}`);
    }

    if (stream === null) {
      const direct = await resolveWebStream(row.episodeId);
      if (direct === null) throw new Error('上游暂时没有可用的播放地址');
      const directTarget = path.join(dir, `第${row.episodeNo}集${qualitySuffix(direct.definition)}.mp4`);
      part = `${directTarget}.part`;
      updateDownload(row.id, { quality: direct.definition, message: '下载中（流畅）' });
      await downloadDirect(
        direct.url,
        part,
        (p) => {
          updateDownload(row.id, { progress: Math.min(0.98, p), message: `下载 ${Math.round(p * 100)}%` });
        },
        ctrl.signal,
      );
      await fsp.rename(part, directTarget);
      part = '';
      const st = await fsp.stat(directTarget);
      updateDownload(row.id, {
        status: 'ready',
        progress: 1,
        message: '已完成',
        bytes: st.size,
        totalBytes: st.size,
        file: directTarget,
        error: '',
      });
      log.info(`下载完成（官网直连）：${row.seriesTitle} 第${row.episodeNo}集 → ${directTarget}`);
      return;
    }

    updateDownload(row.id, { quality: stream.definition });

    const target = path.join(dir, `第${row.episodeNo}集${qualitySuffix(stream.definition)}.mp4`);
    part = `${target}.part`;

    const cached = await transcodeEpisode(
      stream,
      (p) => {
        updateDownload(row.id, { progress: Math.min(0.9, p.progress * 0.9), message: p.message });
      },
      ctrl.signal,
      getSettings().enhanceVideo,
    );

    updateDownload(row.id, { progress: 0.92, message: '写入下载目录' });
    await copyWithProgress(
      cached,
      part,
      (p) => {
        updateDownload(row.id, { progress: 0.92 + p * 0.07, message: `写入 ${Math.round(p * 100)}%` });
      },
      ctrl.signal,
    );
    await fsp.rename(part, target);
    part = '';

    const st = await fsp.stat(target);
    updateDownload(row.id, {
      status: 'ready',
      progress: 1,
      message: '已完成',
      bytes: st.size,
      totalBytes: st.size,
      file: target,
      error: '',
    });
    log.info(`下载完成：${row.seriesTitle} 第${row.episodeNo}集 → ${target}`);
  } catch (err) {
    const reason = ctrl.signal.reason;
    if (reason === 'paused' || reason === 'canceled') {
      updateDownload(row.id, {
        status: reason === 'paused' ? 'paused' : 'canceled',
        message: reason === 'paused' ? '已暂停' : '已取消',
      });
      log.info(`下载${reason === 'paused' ? '暂停' : '取消'}：${row.episodeId}`);
    } else {
      updateDownload(row.id, { status: 'failed', message: '下载失败', error: (err as Error).message });
      log.warn(`下载失败 ${row.episodeId}: ${(err as Error).message}`);
    }
  } finally {
    if (part !== '') await fsp.rm(part, { force: true }).catch(() => undefined);
    active.delete(row.id);
    void pump();
  }
}

/** 启动排队任务，直到并发上限。同步占位，避免同一任务被重复启动。 */
export async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    const limit = Math.min(4, Math.max(1, getSettings().downloadConcurrency));
    for (;;) {
      if (active.size >= limit) break;
      const next = nextQueued();
      if (next === null) break;
      updateDownload(next.id, { status: 'working', progress: 0, message: '准备中', error: '' });
      void run(getDownload(next.id) ?? next);
    }
  } finally {
    pumping = false;
  }
}

export function enqueueDownloads(
  items: Array<{ seriesId: string; seriesTitle: string; cover: string; episodeId: string; episodeNo: number }>,
): number {
  let queued = 0;
  for (const item of items) {
    const row = upsertQueued(item);
    if (row.status === 'queued') queued += 1;
  }
  void pump();
  return queued;
}

export function pauseDownload(id: string): boolean {
  const row = getDownload(id);
  if (row === null) return false;
  const ctrl = active.get(id);
  if (ctrl !== undefined) {
    ctrl.abort('paused');
  } else if (row.status === 'queued' || row.status === 'working') {
    updateDownload(id, { status: 'paused', message: '已暂停' });
  }
  return true;
}

export function resumeDownload(id: string): boolean {
  const row = getDownload(id);
  if (row === null) return false;
  if (row.status === 'ready' || row.status === 'working') return true;
  if (row.status === 'queued') return true;
  updateDownload(id, { status: 'queued', progress: 0, message: '排队中', error: '' });
  void pump();
  return true;
}

export function cancelDownload(id: string): boolean {
  const row = getDownload(id);
  if (row === null) return false;
  const ctrl = active.get(id);
  if (ctrl !== undefined) {
    ctrl.abort('canceled');
  } else if (row.status !== 'ready') {
    updateDownload(id, { status: 'canceled', message: '已取消' });
  }
  return true;
}

/** 删除任务（默认连本地文件一起删，只删下载目录内的路径）。 */
export async function removeDownloadTask(id: string, deleteFile = true): Promise<boolean> {
  const ctrl = active.get(id);
  if (ctrl !== undefined) ctrl.abort('canceled');
  await new Promise((r) => setTimeout(r, 120));

  const row = removeDownload(id);
  if (row === null) return false;
  const downloadDir = path.resolve(getSettings().downloadDir);
  if (deleteFile && row.file !== '') {
    const file = path.resolve(row.file);
    if (file.startsWith(downloadDir + path.sep)) {
      await fsp.rm(file, { force: true }).catch(() => undefined);
    }
  }
  // 顺手清掉空着的剧集目录（非空时 rmdir 会失败，正好保留别人的文件）
  await fsp.rmdir(path.join(downloadDir, safeName(row.seriesTitle))).catch(() => undefined);
  return true;
}

function shellOpen(args: string[]): void {
  const child = spawn(args[0] ?? 'explorer.exe', args.slice(1), { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}

/** 在资源管理器里定位文件（文件不在就打开目录）。 */
export function revealDownload(id: string): boolean {
  const row = getDownload(id);
  if (row !== null && row.file !== '' && fs.existsSync(row.file)) {
    if (process.platform === 'win32') shellOpen(['explorer.exe', '/select,', row.file]);
    else if (process.platform === 'darwin') shellOpen(['open', '-R', row.file]);
    else shellOpen(['xdg-open', path.dirname(row.file)]);
    return true;
  }
  return openDownloadDir();
}

export function openDownloadDir(): boolean {
  const dir = getSettings().downloadDir;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return false;
  }
  if (process.platform === 'win32') shellOpen(['explorer.exe', dir]);
  else if (process.platform === 'darwin') shellOpen(['open', dir]);
  else shellOpen(['xdg-open', dir]);
  return true;
}

export { downloadSummary, listDownloads };
