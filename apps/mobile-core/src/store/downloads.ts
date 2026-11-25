/**
 * 下载任务表（同一个 horun.db，独立连接）。
 *
 * 一集一条，主键就是 episodeId：同一集不会重复下载，重新下载只会覆盖。
 * 状态机：queued → working → ready / failed / paused / canceled。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_ROOT } from '../config.ts';
import { createLogger } from '../util/log.ts';

const log = createLogger('downloads-store');

const FILE = path.join(DATA_ROOT, 'horun.db');
fs.mkdirSync(DATA_ROOT, { recursive: true });
const db = new DatabaseSync(FILE);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS download (
    id            TEXT PRIMARY KEY,
    series_id     TEXT NOT NULL,
    series_title  TEXT NOT NULL,
    cover         TEXT NOT NULL DEFAULT '',
    episode_id    TEXT NOT NULL,
    episode_no    INTEGER NOT NULL,
    quality       TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL,
    progress      REAL NOT NULL DEFAULT 0,
    message       TEXT NOT NULL DEFAULT '',
    bytes         INTEGER NOT NULL DEFAULT 0,
    total_bytes   INTEGER NOT NULL DEFAULT 0,
    file          TEXT NOT NULL DEFAULT '',
    error         TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_download_created ON download(created_at DESC);
`);

export type DownloadStatus = 'queued' | 'working' | 'ready' | 'failed' | 'paused' | 'canceled';

export interface DownloadRow {
  id: string;
  seriesId: string;
  seriesTitle: string;
  cover: string;
  episodeId: string;
  episodeNo: number;
  quality: string;
  status: DownloadStatus;
  progress: number;
  message: string;
  bytes: number;
  totalBytes: number;
  file: string;
  error: string;
  createdAt: number;
  updatedAt: number;
}

interface RawDownload {
  id: string;
  series_id: string;
  series_title: string;
  cover: string;
  episode_id: string;
  episode_no: number;
  quality: string;
  status: string;
  progress: number;
  message: string;
  bytes: number;
  total_bytes: number;
  file: string;
  error: string;
  created_at: number;
  updated_at: number;
}

function map(row: RawDownload): DownloadRow {
  return {
    id: row.id,
    seriesId: row.series_id,
    seriesTitle: row.series_title,
    cover: row.cover,
    episodeId: row.episode_id,
    episodeNo: row.episode_no,
    quality: row.quality,
    status: row.status as DownloadStatus,
    progress: row.progress,
    message: row.message,
    bytes: row.bytes,
    totalBytes: row.total_bytes,
    file: row.file,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface DownloadPatch {
  status?: DownloadStatus;
  progress?: number;
  message?: string;
  bytes?: number;
  totalBytes?: number;
  file?: string;
  error?: string;
  quality?: string;
}

const PATCH_COLUMNS: Record<keyof DownloadPatch, string> = {
  status: 'status',
  progress: 'progress',
  message: 'message',
  bytes: 'bytes',
  totalBytes: 'total_bytes',
  file: 'file',
  error: 'error',
  quality: 'quality',
};

export function getDownload(id: string): DownloadRow | null {
  const row = db.prepare('SELECT * FROM download WHERE id = ?').get(id) as RawDownload | undefined;
  return row === undefined ? null : map(row);
}

export function listDownloads(limit = 500): DownloadRow[] {
  const rows = db.prepare('SELECT * FROM download ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as RawDownload[];
  return rows.map(map);
}

export function nextQueued(): DownloadRow | null {
  const row = db
    .prepare("SELECT * FROM download WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1")
    .get() as RawDownload | undefined;
  return row === undefined ? null : map(row);
}

export function upsertQueued(input: {
  seriesId: string;
  seriesTitle: string;
  cover: string;
  episodeId: string;
  episodeNo: number;
}): DownloadRow {
  const now = Date.now();
  const existing = getDownload(input.episodeId);
  if (existing !== null) {
    // 已完成/进行中的不重复排队；失败/暂停/取消的重置成 queued
    if (existing.status === 'ready' || existing.status === 'working' || existing.status === 'queued') return existing;
    db.prepare(
      `UPDATE download SET status = 'queued', progress = 0, message = '排队中', error = '', updated_at = ? WHERE id = ?`,
    ).run(now, input.episodeId);
    return getDownload(input.episodeId) as DownloadRow;
  }
  db.prepare(
    `INSERT INTO download
       (id, series_id, series_title, cover, episode_id, episode_no, quality, status, progress, message, bytes, total_bytes, file, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '', 'queued', 0, '排队中', 0, 0, '', '', ?, ?)`,
  ).run(
    input.episodeId,
    input.seriesId,
    input.seriesTitle,
    input.cover,
    input.episodeId,
    input.episodeNo,
    now,
    now,
  );
  return getDownload(input.episodeId) as DownloadRow;
}

export function updateDownload(id: string, patch: DownloadPatch): void {
  const sets: string[] = [];
  const values: Array<string | number> = [];
  for (const key of Object.keys(patch) as Array<keyof DownloadPatch>) {
    const value = patch[key];
    if (value === undefined) continue;
    sets.push(`${PATCH_COLUMNS[key]} = ?`);
    values.push(value as string | number);
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  values.push(Date.now());
  db.prepare(`UPDATE download SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
}

export function removeDownload(id: string): DownloadRow | null {
  const row = getDownload(id);
  if (row === null) return null;
  db.prepare('DELETE FROM download WHERE id = ?').run(id);
  return row;
}

/** 应用重启后，上次没跑完的任务不要假装还在跑。 */
export function resetInterrupted(): number {
  const res = db
    .prepare(
      `UPDATE download SET status = 'paused', message = '应用重启，已暂停', updated_at = ? WHERE status IN ('working', 'queued')`,
    )
    .run(Date.now());
  const n = Number(res.changes);
  if (n > 0) log.info(`重置 ${n} 个中断的下载任务`);
  return n;
}

export function downloadSummary(): {
  total: number;
  queued: number;
  working: number;
  ready: number;
  failed: number;
  bytes: number;
} {
  const rows = db.prepare('SELECT status, COUNT(*) AS n, SUM(bytes) AS bytes FROM download GROUP BY status').all() as Array<{
    status: string;
    n: number;
    bytes: number | null;
  }>;
  const out = { total: 0, queued: 0, working: 0, ready: 0, failed: 0, bytes: 0 };
  for (const row of rows) {
    out.total += row.n;
    if (row.status === 'queued') out.queued += row.n;
    else if (row.status === 'working') out.working += row.n;
    else if (row.status === 'ready') out.ready += row.n;
    else if (row.status === 'failed') out.failed += row.n;
    out.bytes += row.bytes ?? 0;
  }
  return out;
}
