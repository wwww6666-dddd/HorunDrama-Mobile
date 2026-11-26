/**
 * 本地进度与追剧（SQLite，node:sqlite 内置，不引第三方依赖）。
 *
 * 设计取舍：
 *  - progress 以 series 为主键：同一部剧只保留"最后看到哪一集、第几秒"，剧场只关心这个；
 *  - episode_watch 另存每集看到的位置/是否看完：详情页要标“已看/上次看到”，
 *    只按集号存一行，几百集也只占很小空间；
 *  - favorite 独立表，后面接账号同步时加 synced 标记即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_ROOT } from '../config.ts';
import { createLogger } from '../util/log.ts';

const log = createLogger('store');

const FILE = path.join(DATA_ROOT, 'horun.db');
fs.mkdirSync(DATA_ROOT, { recursive: true });
const db = new DatabaseSync(FILE);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS progress (
    series_id     TEXT PRIMARY KEY,
    series_title  TEXT NOT NULL,
    cover         TEXT NOT NULL DEFAULT '',
    episode_id    TEXT NOT NULL,
    episode_no    INTEGER NOT NULL,
    position_sec  REAL NOT NULL,
    duration_sec  REAL NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_progress_updated ON progress(updated_at DESC);

  CREATE TABLE IF NOT EXISTS episode_watch (
    series_id     TEXT NOT NULL,
    episode_id    TEXT NOT NULL,
    episode_no    INTEGER NOT NULL,
    position_sec  REAL NOT NULL DEFAULT 0,
    duration_sec  REAL NOT NULL DEFAULT 0,
    completed     INTEGER NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (series_id, episode_id)
  );
  CREATE INDEX IF NOT EXISTS idx_episode_watch_series ON episode_watch(series_id, episode_no);

  CREATE TABLE IF NOT EXISTS favorite (
    series_id     TEXT PRIMARY KEY,
    series_title  TEXT NOT NULL,
    cover         TEXT NOT NULL DEFAULT '',
    episode_count INTEGER NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_favorite_updated ON favorite(updated_at DESC);

  CREATE TABLE IF NOT EXISTS liked (
    series_id     TEXT PRIMARY KEY,
    series_title  TEXT NOT NULL,
    cover         TEXT NOT NULL DEFAULT '',
    episode_count INTEGER NOT NULL DEFAULT 0,
    episode_id    TEXT NOT NULL DEFAULT '',
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_liked_updated ON liked(updated_at DESC);

  CREATE TABLE IF NOT EXISTS follow (
    series_id     TEXT PRIMARY KEY,
    series_title  TEXT NOT NULL,
    cover         TEXT NOT NULL DEFAULT '',
    episode_count INTEGER NOT NULL DEFAULT 0,
    followed_at   INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_follow_updated ON follow(updated_at DESC);

  CREATE TABLE IF NOT EXISTS reservation (
    series_id     TEXT PRIMARY KEY,
    series_title  TEXT NOT NULL,
    cover         TEXT NOT NULL DEFAULT '',
    episode_count INTEGER NOT NULL DEFAULT 0,
    online        INTEGER NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reservation_updated ON reservation(updated_at DESC);
`);

// 老库补列：点赞需要记住具体是哪一集（账号点赞是按 vid 的）
try {
  db.exec("ALTER TABLE liked ADD COLUMN episode_id TEXT NOT NULL DEFAULT ''");
} catch {
  /* 已经有这一列 */
}

export interface ProgressRow {
  seriesId: string;
  seriesTitle: string;
  cover: string;
  episodeId: string;
  episodeNo: number;
  positionSec: number;
  durationSec: number;
  updatedAt: number;
}

export interface FavoriteRow {
  seriesId: string;
  seriesTitle: string;
  cover: string;
  episodeCount: number;
  updatedAt: number;
}

export interface EpisodeWatchRow {
  seriesId: string;
  episodeId: string;
  episodeNo: number;
  positionSec: number;
  durationSec: number;
  completed: boolean;
  updatedAt: number;
}

interface RawProgress {
  series_id: string;
  series_title: string;
  cover: string;
  episode_id: string;
  episode_no: number;
  position_sec: number;
  duration_sec: number;
  updated_at: number;
}

interface RawFavorite {
  series_id: string;
  series_title: string;
  cover: string;
  episode_count: number;
  updated_at: number;
}

interface RawEpisodeWatch {
  series_id: string;
  episode_id: string;
  episode_no: number;
  position_sec: number;
  duration_sec: number;
  completed: number;
  updated_at: number;
}

const toProgress = (r: RawProgress): ProgressRow => ({
  seriesId: r.series_id,
  seriesTitle: r.series_title,
  cover: r.cover,
  episodeId: r.episode_id,
  episodeNo: r.episode_no,
  positionSec: r.position_sec,
  durationSec: r.duration_sec,
  updatedAt: r.updated_at,
});

const toFavorite = (r: RawFavorite): FavoriteRow => ({
  seriesId: r.series_id,
  seriesTitle: r.series_title,
  cover: r.cover,
  episodeCount: r.episode_count,
  updatedAt: r.updated_at,
});

const toEpisodeWatch = (r: RawEpisodeWatch): EpisodeWatchRow => ({
  seriesId: r.series_id,
  episodeId: r.episode_id,
  episodeNo: r.episode_no,
  positionSec: r.position_sec,
  durationSec: r.duration_sec,
  completed: r.completed === 1,
  updatedAt: r.updated_at,
});

export function saveProgress(input: {
  seriesId: string;
  seriesTitle: string;
  cover: string;
  episodeId: string;
  episodeNo: number;
  positionSec: number;
  durationSec: number;
}): void {
  // 结尾 5 秒内视为看完：主进度归零，下次从这一集开头播；分集记录标 completed。
  const nearEnd = input.durationSec > 30 && input.positionSec > input.durationSec - 5;
  const completed = nearEnd || (input.durationSec > 30 && input.positionSec >= input.durationSec * 0.92);
  const now = Date.now();
  db.prepare(
    `INSERT INTO progress (series_id, series_title, cover, episode_id, episode_no, position_sec, duration_sec, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(series_id) DO UPDATE SET
       series_title = excluded.series_title,
       cover = excluded.cover,
       episode_id = excluded.episode_id,
       episode_no = excluded.episode_no,
       position_sec = excluded.position_sec,
       duration_sec = excluded.duration_sec,
       updated_at = excluded.updated_at`,
  ).run(
    input.seriesId,
    input.seriesTitle,
    input.cover,
    input.episodeId,
    input.episodeNo,
    nearEnd ? 0 : Math.max(0, input.positionSec),
    input.durationSec,
    now,
  );
  db.prepare(
    `INSERT INTO episode_watch (series_id, episode_id, episode_no, position_sec, duration_sec, completed, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(series_id, episode_id) DO UPDATE SET
       episode_no = excluded.episode_no,
       position_sec = CASE WHEN excluded.completed = 1 THEN 0 ELSE excluded.position_sec END,
       duration_sec = excluded.duration_sec,
       completed = MAX(episode_watch.completed, excluded.completed),
       updated_at = excluded.updated_at`,
  ).run(
    input.seriesId,
    input.episodeId,
    input.episodeNo,
    completed ? 0 : Math.max(0, input.positionSec),
    input.durationSec,
    completed ? 1 : 0,
    now,
  );
}

/** 详情页用：这部剧每一集看到哪里、哪些已经看完。 */
export function listEpisodeWatch(seriesId: string, limit = 500): EpisodeWatchRow[] {
  const rows = db
    .prepare('SELECT * FROM episode_watch WHERE series_id = ? ORDER BY episode_no ASC LIMIT ?')
    .all(seriesId, limit) as unknown as RawEpisodeWatch[];
  return rows.map(toEpisodeWatch);
}

export function getProgress(seriesId: string): ProgressRow | null {
  const row = db.prepare('SELECT * FROM progress WHERE series_id = ?').get(seriesId) as RawProgress | undefined;
  return row === undefined ? null : toProgress(row);
}

export function listContinue(limit = 12): ProgressRow[] {
  const rows = db.prepare('SELECT * FROM progress ORDER BY updated_at DESC LIMIT ?').all(limit) as unknown as RawProgress[];
  return rows.map(toProgress);
}

export function clearProgress(seriesId?: string): number {
  if (seriesId === undefined || seriesId === '') {
    const res = db.prepare('DELETE FROM progress').run();
    db.prepare('DELETE FROM episode_watch').run();
    return Number(res.changes);
  }
  const res = db.prepare('DELETE FROM progress WHERE series_id = ?').run(seriesId);
  db.prepare('DELETE FROM episode_watch WHERE series_id = ?').run(seriesId);
  return Number(res.changes);
}

/** 退出登录时清掉所有账号相关本地数据（追更/收藏/点赞/预约/进度）。 */
export function clearAccountData(): void {
  db.exec('DELETE FROM follow; DELETE FROM favorite; DELETE FROM liked; DELETE FROM reservation; DELETE FROM progress; DELETE FROM episode_watch;');
  log.info('已清除账号相关本地数据');
}

export function toggleFavorite(input: {
  seriesId: string;
  seriesTitle: string;
  cover: string;
  episodeCount: number;
}): { added: boolean } {
  const exists = db.prepare('SELECT 1 FROM favorite WHERE series_id = ?').get(input.seriesId);
  if (exists !== undefined) {
    db.prepare('DELETE FROM favorite WHERE series_id = ?').run(input.seriesId);
    return { added: false };
  }
  db.prepare(
    `INSERT INTO favorite (series_id, series_title, cover, episode_count, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.seriesId, input.seriesTitle, input.cover, input.episodeCount, Date.now());
  return { added: true };
}

export function listFavorites(limit = 200): FavoriteRow[] {
  const rows = db.prepare('SELECT * FROM favorite ORDER BY updated_at DESC LIMIT ?').all(limit) as unknown as RawFavorite[];
  return rows.map(toFavorite);
}

export function isFavorite(seriesId: string): boolean {
  return db.prepare('SELECT 1 FROM favorite WHERE series_id = ?').get(seriesId) !== undefined;
}

// ---------------- 点赞（本地，参考 local_like） ----------------

export interface LikeRow {
  seriesId: string;
  seriesTitle: string;
  cover: string;
  episodeCount: number;
  updatedAt: number;
}

interface RawLike {
  series_id: string;
  series_title: string;
  cover: string;
  episode_count: number;
  updated_at: number;
}

const toLike = (r: RawLike): LikeRow => ({
  seriesId: r.series_id,
  seriesTitle: r.series_title,
  cover: r.cover,
  episodeCount: r.episode_count,
  updatedAt: r.updated_at,
});

export function toggleLike(input: {
  seriesId: string;
  seriesTitle: string;
  cover: string;
  episodeCount: number;
  episodeId?: string;
}): { liked: boolean } {
  const exists = db.prepare('SELECT 1 FROM liked WHERE series_id = ?').get(input.seriesId);
  if (exists !== undefined) {
    db.prepare('DELETE FROM liked WHERE series_id = ?').run(input.seriesId);
    return { liked: false };
  }
  db.prepare(
    `INSERT INTO liked (series_id, series_title, cover, episode_count, episode_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(series_id) DO UPDATE SET
       series_title = excluded.series_title,
       cover = excluded.cover,
       episode_count = excluded.episode_count,
       episode_id = excluded.episode_id,
       updated_at = excluded.updated_at`,
  ).run(
    input.seriesId,
    input.seriesTitle,
    input.cover,
    input.episodeCount,
    input.episodeId ?? '',
    Date.now(),
  );
  return { liked: true };
}

/** 账号点赞写回时用：这条点赞具体是哪一集。 */
export function getLike(seriesId: string): { episodeId: string } | null {
  const row = db.prepare('SELECT episode_id FROM liked WHERE series_id = ?').get(seriesId) as
    | { episode_id: string }
    | undefined;
  return row === undefined ? null : { episodeId: row.episode_id };
}

export function listLikes(limit = 200): LikeRow[] {
  const rows = db.prepare('SELECT * FROM liked ORDER BY updated_at DESC LIMIT ?').all(limit) as unknown as RawLike[];
  return rows.map(toLike);
}

export function isLiked(seriesId: string): boolean {
  return db.prepare('SELECT 1 FROM liked WHERE series_id = ?').get(seriesId) !== undefined;
}

// ---------------- 追更（本地，记录「上次看到的总集数」用来判断有没有新集） ----------------

export interface FollowRow {
  seriesId: string;
  seriesTitle: string;
  cover: string;
  /** 上次确认过的总集数 */
  episodeCount: number;
  followedAt: number;
  updatedAt: number;
}

interface RawFollow {
  series_id: string;
  series_title: string;
  cover: string;
  episode_count: number;
  followed_at: number;
  updated_at: number;
}

const toFollow = (r: RawFollow): FollowRow => ({
  seriesId: r.series_id,
  seriesTitle: r.series_title,
  cover: r.cover,
  episodeCount: r.episode_count,
  followedAt: r.followed_at,
  updatedAt: r.updated_at,
});

export function toggleFollow(input: {
  seriesId: string;
  seriesTitle: string;
  cover: string;
  episodeCount: number;
}): { following: boolean } {
  const exists = db.prepare('SELECT 1 FROM follow WHERE series_id = ?').get(input.seriesId);
  if (exists !== undefined) {
    db.prepare('DELETE FROM follow WHERE series_id = ?').run(input.seriesId);
    return { following: false };
  }
  const now = Date.now();
  db.prepare(
    `INSERT INTO follow (series_id, series_title, cover, episode_count, followed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.seriesId, input.seriesTitle, input.cover, input.episodeCount, now, now);
  return { following: true };
}

export function listFollows(limit = 200): FollowRow[] {
  const rows = db.prepare('SELECT * FROM follow ORDER BY updated_at DESC LIMIT ?').all(limit) as unknown as RawFollow[];
  return rows.map(toFollow);
}

export function isFollowing(seriesId: string): boolean {
  return db.prepare('SELECT 1 FROM follow WHERE series_id = ?').get(seriesId) !== undefined;
}

/** 把「已确认集数」更新到最新，返回是否原先是旧的（=有新集）。 */
export function updateFollowCount(seriesId: string, episodeCount: number): boolean {
  const row = db.prepare('SELECT episode_count FROM follow WHERE series_id = ?').get(seriesId) as
    | { episode_count: number }
    | undefined;
  if (row === undefined) return false;
  const changed = episodeCount > row.episode_count;
  if (changed) {
    db.prepare('UPDATE follow SET episode_count = ?, updated_at = ? WHERE series_id = ?').run(
      episodeCount,
      Date.now(),
      seriesId,
    );
  }
  return changed;
}

/** 账号历史同步：只有比本地更新的记录才覆盖。返回是否写入。 */
export function upsertProgressAt(input: {
  seriesId: string;
  seriesTitle: string;
  cover: string;
  episodeId: string;
  episodeNo: number;
  positionSec: number;
  durationSec: number;
  updatedAt: number;
}): boolean {
  const nearEnd = input.durationSec > 30 && input.positionSec > input.durationSec - 5;
  const res = db
    .prepare(
      `INSERT INTO progress (series_id, series_title, cover, episode_id, episode_no, position_sec, duration_sec, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(series_id) DO UPDATE SET
         series_title = excluded.series_title,
         cover = excluded.cover,
         episode_id = excluded.episode_id,
         episode_no = excluded.episode_no,
         position_sec = excluded.position_sec,
         duration_sec = excluded.duration_sec,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at >= progress.updated_at`,
    )
    .run(
      input.seriesId,
      input.seriesTitle,
      input.cover,
      input.episodeId,
      input.episodeNo,
      nearEnd ? 0 : Math.max(0, input.positionSec),
      input.durationSec,
      input.updatedAt,
    );
  return Number(res.changes) > 0;
}

/** 账号书架同步：补全/更新本地收藏（不会删掉本地多出来的收藏）。 */
export function upsertFavoriteAt(input: {
  seriesId: string;
  seriesTitle: string;
  cover: string;
  episodeCount: number;
  updatedAt: number;
}): boolean {
  const res = db
    .prepare(
      `INSERT INTO favorite (series_id, series_title, cover, episode_count, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(series_id) DO UPDATE SET
         series_title = excluded.series_title,
         cover = excluded.cover,
         episode_count = excluded.episode_count,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at > favorite.updated_at`,
    )
    .run(input.seriesId, input.seriesTitle, input.cover, input.episodeCount, input.updatedAt);
  return Number(res.changes) > 0;
}

/** 账号订阅（追更）同步：账号是订阅的来源，直接覆盖标题/封面/集数。 */
export function upsertFollowAt(input: {
  seriesId: string;
  seriesTitle: string;
  cover: string;
  episodeCount: number;
  updatedAt: number;
}): boolean {
  const now = Date.now();
  const res = db
    .prepare(
      `INSERT INTO follow (series_id, series_title, cover, episode_count, followed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(series_id) DO UPDATE SET
         series_title = excluded.series_title,
         cover = excluded.cover,
         episode_count = excluded.episode_count,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at >= follow.updated_at`,
    )
    .run(input.seriesId, input.seriesTitle, input.cover, input.episodeCount, now, input.updatedAt);
  return Number(res.changes) > 0;
}

// ---------------- 预约（账号同步；写接口缺失，所以只做只读） ----------------

export interface ReservationInput {
  seriesId: string;
  seriesTitle: string;
  cover: string;
  episodeCount: number;
  online: boolean;
  updatedAt: number;
}

export interface ReservationRow {
  seriesId: string;
  seriesTitle: string;
  cover: string;
  episodeCount: number;
  online: boolean;
  updatedAt: number;
}

interface RawReservation {
  series_id: string;
  series_title: string;
  cover: string;
  episode_count: number;
  online: number;
  updated_at: number;
}

export function replaceReservations(items: ReservationInput[]): number {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM reservation').run();
    const insert = db.prepare(
      `INSERT INTO reservation (series_id, series_title, cover, episode_count, online, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const item of items) {
      insert.run(
        item.seriesId,
        item.seriesTitle,
        item.cover,
        item.episodeCount,
        item.online ? 1 : 0,
        item.updatedAt,
      );
    }
    db.exec('COMMIT');
    return items.length;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function listReservations(limit = 200): ReservationRow[] {
  const rows = db
    .prepare('SELECT * FROM reservation ORDER BY online ASC, updated_at DESC LIMIT ?')
    .all(limit) as unknown as RawReservation[];
  return rows.map((row) => ({
    seriesId: row.series_id,
    seriesTitle: row.series_title,
    cover: row.cover,
    episodeCount: row.episode_count,
    online: row.online === 1,
    updatedAt: row.updated_at,
  }));
}

export function addReservation(item: ReservationInput): void {
  db.prepare(
    `INSERT INTO reservation (series_id, series_title, cover, episode_count, online, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(series_id) DO UPDATE SET
       series_title = excluded.series_title,
       cover = excluded.cover,
       episode_count = excluded.episode_count,
       online = excluded.online,
       updated_at = excluded.updated_at`,
  ).run(item.seriesId, item.seriesTitle, item.cover, item.episodeCount, item.online ? 1 : 0, item.updatedAt);
}

export function removeReservation(seriesId: string): void {
  db.prepare('DELETE FROM reservation WHERE series_id = ?').run(seriesId);
}

export function stats(): { progress: number; favorites: number; file: string } {
  const p = db.prepare('SELECT COUNT(*) AS n FROM progress').get() as { n: number };
  const f = db.prepare('SELECT COUNT(*) AS n FROM favorite').get() as { n: number };
  return { progress: p.n, favorites: f.n, file: FILE };
}

log.debug(`进度库就绪 ${FILE}`);
