/** 接口注册：所有 /api/* 都从这里出去。响应统一 { ok, data } / { ok:false, code, message }。 */
import type http from 'node:http';
import fs from 'node:fs';
import { Router, type Ctx } from './router.ts';
import { category, coverForSeries, filterRows, home, rankPage, search, series, seriesCounts, suggestions } from '../sources/catalog.ts';
import { danmakuSlice } from '../sources/danmaku.ts';
import { fetchComments, fetchReplies } from '../sources/comments.ts';
import { accountStatus, logout, verifySession } from '../account/index.ts';
import { accountResumeFor, clearAccountCaches, syncAccountData } from '../account/data.ts';
import {
  accountLoggedIn,
  accountDeleteComment,
  accountLikeComment,
  accountSendComment,
  accountSendDanmaku,
  accountSetFavorite,
  accountSetLike,
  accountSetReservation,
  accountUploadProgress,
} from '../account/write.ts';
import { loginWithSms, sendSmsCode, continueSmsLogin } from '../account/sms.ts';
import { pollQr, startQr } from '../account/qr.ts';
import { writeSession } from '../account/session.ts';
import { feedPage, type FeedTab } from '../sources/feed.ts';
import { newReleasesPage } from '../sources/newReleases.ts';
import { fetchImage } from '../media/images.ts';
import { clearImageCache, imageCacheStats } from '../media/images.ts';
import { clearMediaCache, mediaCacheStats } from '../media/transcode.ts';
import { getSettings, updateSettings } from '../store/settings.ts';
import { getJob, jobView, startEpisode, startUpgradeJob } from '../media/jobs.ts';
import { streamLiveMp4 } from '../media/live.ts';
import { schedulePreload } from '../media/preload.ts';
import { resolveEpisodeStream } from '../sources/playback.ts';
import {
  cancelDownload,
  downloadSummary,
  enqueueDownloads,
  listDownloads,
  openDownloadDir,
  pauseDownload,
  removeDownloadTask,
  resumeDownload,
  revealDownload,
} from '../media/downloads.ts';
import { mediaFilePath } from '../media/transcode.ts';
import { refreshWebStream, resolveWebStream, warmWebStream } from '../sources/webplay.ts';
import {
  addReservation,
  clearProgress,
  getLike,
  getProgress,
  isFavorite,
  isFollowing,
  clearAccountData,
  isLiked,
  listContinue,
  listFavorites,
  listFollows,
  listLikes,
  listReservations,
  removeReservation,
  saveProgress,
  toggleFavorite,
  toggleFollow,
  toggleLike,
  updateFollowCount,
} from '../store/progress.ts';
import { DATA_ROOT, VERSION } from '../config.ts';
import { createLogger } from '../util/log.ts';

const log = createLogger('api');
const startedAt = Date.now();
/** 进度上报节流：同一部剧 8 秒内只往账号写一次。 */
const progressUploadAt = new Map<string, number>();

function ok(res: http.ServerResponse, data: unknown): void {
  const body = JSON.stringify({ ok: true, data });
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function fail(res: http.ServerResponse, status: number, code: string, message: string): void {
  const body = JSON.stringify({ ok: false, code, message });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** 上游错误统一翻译成用户能懂的话，别把 stack 丢给前端。 */
function toUserMessage(err: unknown): { code: string; message: string; status: number } {
  const code = (err as { code?: string }).code ?? '';
  const message = (err as Error).message ?? '未知错误';
  if (code === 'ANONYMOUS_LIMITED' || code === 'RATE_LIMITED') {
    return { code: 'upstream_limited', message: '上游限流了，等一两分钟再试', status: 429 };
  }
  if (/timeout|ECONNRESET|fetch failed/i.test(message)) {
    return { code: 'upstream_down', message: '连不上上游，检查网络后再试', status: 502 };
  }
  return { code: 'upstream_error', message, status: 502 };
}

function num(value: string | null, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 读 JSON body（上限 256 KB，够用且防止被打爆内存）。 */
async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 256 * 1024) throw new Error('body 太大');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function numberOr(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function registerRoutes(router: Router): void {
  router.get('/api/health', ({ res }: Ctx) => {
    ok(res, {
      ok: true,
      name: 'HorunDrama core',
      version: VERSION,
      dataRoot: DATA_ROOT,
      node: process.version,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    });
  });

  // 2.0.0：删掉废弃的 /api/meta（stage/features 是早期占位数据，前端从未使用，
  // 留着只会给扫描器多一个无意义入口）。

  router.get('/api/home', async ({ res }: Ctx) => {    try {
      ok(res, await home());
    } catch (err) {
      log.warn(`首页失败: ${(err as Error).message}`);
      const e = toUserMessage(err);
      fail(res, e.status, e.code, e.message);
    }
  });

  // 推荐流：游标分页，一页几部剧
  router.get('/api/feed', async ({ res, url }: Ctx) => {
    try {
      const tabRaw = url.searchParams.get('tab') ?? 'recommend';
      const tab: FeedTab =
        tabRaw === 'follow' || tabRaw === 'live' || tabRaw === 'anime' ? tabRaw : 'recommend';
      ok(
        res,
        await feedPage(
          url.searchParams.get('cursor') ?? '',
          tab,
          url.searchParams.get('refresh') === '1',
        ),
      );
    } catch (err) {
      const e = toUserMessage(err);
      fail(res, e.status, e.code, e.message);
    }
  });

  // 上新日历（新剧）：date=YYYYMMDD，cursor 翻页
  router.get('/api/new-releases', async ({ res, url }: Ctx) => {
    try {
      ok(res, await newReleasesPage(url.searchParams.get('date') ?? '', url.searchParams.get('cursor') ?? ''));
    } catch (err) {
      const e = toUserMessage(err);
      fail(res, e.status, e.code, e.message);
    }
  });

  router.get('/api/suggest', async ({ res, url }: Ctx) => {
    const q = (url.searchParams.get('q') ?? '').trim();
    if (q === '') {
      ok(res, []);
      return;
    }
    try {
      ok(res, await suggestions(q));
    } catch (err) {
      const e = toUserMessage(err);
      fail(res, e.status, e.code, e.message);
    }
  });

  router.get('/api/search', async ({ res, url }: Ctx) => {
    const q = (url.searchParams.get('q') ?? '').trim();
    if (q === '') {
      fail(res, 400, 'empty_query', '请输入关键词');
      return;
    }
    try {
      ok(res, await search(q, num(url.searchParams.get('page'), 1), url.searchParams.get('tab') ?? ''));
    } catch (err) {
      const e = toUserMessage(err);
      fail(res, e.status, e.code, e.message);
    }
  });

  router.get('/api/filters', async ({ res, url }: Ctx) => {
    try {
      const genre = url.searchParams.get('genre') ?? undefined;
      ok(res, { rows: await filterRows(genre) });
    } catch (err) {
      const e = toUserMessage(err);
      fail(res, e.status, e.code, e.message);
    }
  });

  router.get('/api/category', async ({ res, url }: Ctx) => {
    let selections: Record<string, string[]> = {};
    const raw = url.searchParams.get('selections');
    if (raw !== null && raw !== '') {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        for (const [k, v] of Object.entries(parsed)) {
          if (Array.isArray(v)) {
            const list = v.filter((x): x is string => typeof x === 'string' && x !== '');
            if (list.length > 0) selections[k] = list;
          }
        }
      } catch {
        fail(res, 400, 'bad_selections', 'selections 不是合法 JSON');
        return;
      }
    }
    try {
      ok(res, await category(selections, num(url.searchParams.get('page'), 1)));
    } catch (err) {
      const e = toUserMessage(err);
      fail(res, e.status, e.code, e.message);
    }
  });

  router.get('/api/rank', async ({ res, url }: Ctx) => {
    try {
      ok(
        res,
        await rankPage(
          url.searchParams.get('content') ?? '',
          url.searchParams.get('board') ?? '',
          url.searchParams.get('cursor') ?? '',
        ),
      );
    } catch (err) {
      const e = toUserMessage(err);
      fail(res, e.status, e.code, e.message);
    }
  });

  // 详情：剧集 + 分集 + 相关推荐 + 多季
  router.get('/api/series/:seriesId', async ({ res, params }: Ctx) => {
    const id = params.seriesId ?? '';
    if (!/^\d{6,25}$/.test(id)) {
      fail(res, 400, 'bad_series_id', '剧 id 不合法');
      return;
    }
    try {
      ok(res, await series(id));
    } catch (err) {
      const e = toUserMessage(err);
      fail(res, e.status, e.code, e.message);
    }
  });

  // 搜索结果缺封面：按 seriesId 取详情补图（带缓存，前端懒加载天然控并发）
  router.get('/api/poster/:seriesId', async ({ res, params }: Ctx) => {
    const id = params.seriesId ?? '';
    if (!/^\d{6,25}$/.test(id)) {
      fail(res, 400, 'bad_series_id', '剧 id 不合法');
      return;
    }
    try {
      const cover = await coverForSeries(id);
      if (cover === '') {
        res.writeHead(404, { 'cache-control': 'no-store' });
        res.end();
        return;
      }
      const img = await fetchImage(cover);
      res.writeHead(200, {
        'content-type': img.contentType,
        'content-length': img.body.length,
        'cache-control': 'public, max-age=86400',
      });
      res.end(img.body);
    } catch (err) {
      log.debug(`封面补取失败 ${id}: ${(err as Error).message}`);
      res.writeHead(404, { 'cache-control': 'no-store' });
      res.end();
    }
  });

  router.get('/api/img', async ({ res, url }: Ctx) => {
    const target = url.searchParams.get('url') ?? '';
    if (target === '') {
      fail(res, 400, 'no_url', '缺少 url 参数');
      return;
    }
    try {
      const img = await fetchImage(target);
      res.writeHead(200, {
        'content-type': img.contentType,
        'content-length': img.body.length,
        'cache-control': 'public, max-age=86400',
      });
      res.end(img.body);
    } catch (err) {
      const message = (err as Error).message;
      // 图挂了不应该让页面报错，回一个 1x1 透明 PNG 更稳
      if (message === 'image_host_not_allowed' || message.startsWith('image_')) {
        log.debug(`图片失败 ${message}: ${target.slice(0, 80)}`);
        res.writeHead(404, { 'cache-control': 'no-store' });
        res.end();
        return;
      }
      fail(res, 502, 'image_failed', message);
    }
  });

  // 播放：优先本地缓存 → 官网 360p 直连（秒开）→ App 源转码（高清）
  // quality=auto|smooth|480p|720p|1080p；upgrade=1 时允许后台准备高清
  router.get('/api/play/:episodeId', async ({ res, params, url }: Ctx) => {
    const id = params.episodeId ?? '';
    if (!/^\d{6,25}$/.test(id)) {
      fail(res, 400, 'bad_episode_id', '集 id 不合法');
      return;
    }
    const asked = url.searchParams.get('quality') ?? '';
    const quality = /^(auto|smooth|\d{3,4}p)$/.test(asked) ? asked : getSettings().defaultQuality;
    const upgrade = url.searchParams.get('upgrade') === '1';
    const hevc = url.searchParams.get('hevc') === '1';
    const live = url.searchParams.get('live') === '1';
    const wait = url.searchParams.get('wait') === '1';
    try {
      ok(res, jobView(await startEpisode(id, quality, { upgrade, hevc, live, wait })));
    } catch (err) {
      fail(res, 502, 'play_failed', (err as Error).message);
    }
  });

  // 轮询转码进度
  router.get('/api/prepare/:jobId', ({ res, params }: Ctx) => {
    const job = getJob(params.jobId ?? '');
    if (job === undefined) {
      fail(res, 404, 'no_job', '任务不存在或已过期');
      return;
    }
    ok(res, jobView(job));
  });

  // 直播式秒开：上游 CENC(HEVC) 源 → 实时解密 + 重封装 fMP4，边收边播
  router.get('/api/live/:episodeId', async ({ res, params, url }: Ctx) => {
    const id = params.episodeId ?? '';
    if (!/^\d{6,25}$/.test(id)) {
      fail(res, 400, 'bad_episode_id', '集 id 不合法');
      return;
    }
    const asked = url.searchParams.get('quality') ?? '';
    const quality = /^(auto|smooth|\d{3,4}p)$/.test(asked) ? asked : '1080p';
    const stream = await resolveEpisodeStream(id, quality, 1).catch(() => null);
    if (stream === null) {
      fail(res, 502, 'no_stream', '上游暂时取不到这一集的播放地址');
      return;
    }
    streamLiveMp4(stream, res);
  });

  // 预加载：以当前集为中心，前后各预加载若干集（集数取设置里的 preloadCount）
  router.post('/api/preload', async ({ req, res }: Ctx) => {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      fail(res, 400, 'bad_body', '请求体不是合法 JSON');
      return;
    }
    const raw = Array.isArray(body.episodeIds) ? body.episodeIds : [];
    const episodeIds: string[] = [];
    for (const item of raw.slice(0, 40)) {
      const id = typeof item === 'string' ? item : '';
      if (/^\d{6,25}$/.test(id)) episodeIds.push(id);
    }
    const askedQuality = typeof body.quality === 'string' ? body.quality : '';
    const quality = /^(auto|smooth|\d{3,4}p)$/.test(askedQuality) ? askedQuality : '1080p';
    const queued = schedulePreload({ episodeIds, quality, hevc: body.hevc === true });
    ok(res, { queued, limit: getSettings().preloadCount });
  });

  // 预热：下一集的官网 360p 地址先取好（便宜且必成，播放页在播到 25s 时调）
  router.get('/api/prewarm/:episodeId', ({ res, params }: Ctx) => {
    const id = params.episodeId ?? '';
    if (!/^\d{6,25}$/.test(id)) {
      fail(res, 400, 'bad_episode_id', '集 id 不合法');
      return;
    }
    warmWebStream(id);
    ok(res, { warming: true });
  });

  // 只起高清任务（不动正在播的）：前端发现上游限流解除后定时调用
  router.get('/api/upgrade/:episodeId', async ({ res, params, url }: Ctx) => {
    const id = params.episodeId ?? '';
    if (!/^\d{6,25}$/.test(id)) {
      fail(res, 400, 'bad_episode_id', '集 id 不合法');
      return;
    }
    const asked = url.searchParams.get('quality') ?? '720p';
    const hevc = url.searchParams.get('hevc') === '1';
    try {
      const job = await startUpgradeJob(id, asked, hevc);
      if (job === null) {
        fail(res, 503, 'hd_unavailable', '高清暂时取不到（上游限流），稍后再试');
        return;
      }
      ok(res, jobView(job));
    } catch (err) {
      fail(res, 502, 'upgrade_failed', (err as Error).message);
    }
  });

  // ---------------- 下载管理 ----------------

  router.get('/api/downloads', ({ res }: Ctx) => {
    ok(res, {
      items: listDownloads(),
      summary: downloadSummary(),
      dir: getSettings().downloadDir,
    });
  });

  router.post('/api/download', async ({ req, res }: Ctx) => {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      fail(res, 400, 'bad_body', '请求体不是合法 JSON');
      return;
    }
    const seriesId = str(body.seriesId);
    const seriesTitle = str(body.seriesTitle, '未命名');
    const cover = str(body.cover);
    if (!/^\d{6,25}$/.test(seriesId)) {
      fail(res, 400, 'bad_series_id', '剧 id 不合法');
      return;
    }
    const raw = Array.isArray(body.episodes) ? body.episodes : [];
    const episodes: Array<{ episodeId: string; no: number }> = [];
    for (const item of raw.slice(0, 300)) {
      const value = item as Record<string, unknown>;
      const episodeId = str(value.episodeId);
      const no = numberOr(value.no, 0);
      if (/^\d{6,25}$/.test(episodeId) && no > 0) episodes.push({ episodeId, no });
    }
    if (episodes.length === 0) {
      fail(res, 400, 'no_episodes', '没有可下载的集');
      return;
    }
    const queued = enqueueDownloads(
      episodes.map((ep) => ({ seriesId, seriesTitle, cover, episodeId: ep.episodeId, episodeNo: ep.no })),
    );
    ok(res, { queued, summary: downloadSummary() });
  });

  router.post('/api/download/action', async ({ req, res }: Ctx) => {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      fail(res, 400, 'bad_body', '请求体不是合法 JSON');
      return;
    }
    const action = str(body.action);
    const id = str(body.id);
    if (!/^\d{6,25}$/.test(id)) {
      fail(res, 400, 'bad_id', '任务 id 不合法');
      return;
    }
    switch (action) {
      case 'pause':
        ok(res, { ok: pauseDownload(id) });
        return;
      case 'resume':
      case 'retry':
        ok(res, { ok: resumeDownload(id) });
        return;
      case 'cancel':
        ok(res, { ok: cancelDownload(id) });
        return;
      case 'remove':
        ok(res, { ok: await removeDownloadTask(id, true) });
        return;
      case 'reveal':
        ok(res, { ok: revealDownload(id) });
        return;
      default:
        fail(res, 400, 'bad_action', `未知操作：${action}`);
    }
  });

  router.post('/api/download/open-dir', ({ res }: Ctx) => {
    ok(res, { ok: openDownloadDir() });
  });

  // ---------------- 账号 ----------------

  router.get('/api/account/status', async ({ res }: Ctx) => {
    ok(res, await accountStatus());
  });

  router.get('/api/account/verify', async ({ res }: Ctx) => {
    ok(res, await verifySession());
  });

  // 从账号拉收藏 / 历史 / 预约，合并进本地库
  router.post('/api/account/sync', async ({ req, res }: Ctx) => {
    const body = await readJson(req).catch(() => ({} as Record<string, unknown>));
    ok(res, await syncAccountData(body.force === true));
  });

  // 账号里这部剧看到哪了（续播用）
  router.get('/api/account/progress/:seriesId', async ({ res, params }: Ctx) => {
    const seriesId = params.seriesId ?? '';
    if (!/^\d{6,25}$/.test(seriesId) || !accountLoggedIn()) {
      ok(res, null);
      return;
    }
    try {
      ok(res, await accountResumeFor(seriesId));
    } catch (err) {
      fail(res, 502, 'account_resume_failed', (err as Error).message);
    }
  });

  // 桌面端内嵌官方登录页登录成功后，把会话 Cookie 交过来落盘
  router.post('/api/account/session', async ({ req, res }: Ctx) => {
    const body = await readJson(req).catch(() => ({} as Record<string, unknown>));
    const cookie = str(body.cookie).trim();
    if (cookie === '') {
      ok(res, { ok: false, message: '没有收到 Cookie' });
      return;
    }
    writeSession({ cookie, source: 'qrcode', profile: { loggedIn: true } });
    const check = await verifySession();
    ok(res, { ok: check.ok, message: check.ok ? '登录成功' : `已写入会话，校验未通过：${check.message}` });
  });
  router.post('/api/account/logout', ({ res }: Ctx) => {
    logout();
    clearAccountCaches();
    clearAccountData();
    ok(res, { loggedIn: false });
  });

  router.post('/api/account/login/qr/start', async ({ res }: Ctx) => {
    ok(res, await startQr());
  });

  router.get('/api/account/login/qr/poll', async ({ req, res }: Ctx) => {
    const token = new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? '';
    ok(res, await pollQr(token));
  });
  router.post('/api/account/login/send-code', async ({ req, res }: Ctx) => {
    const body = await readJson(req).catch(() => ({} as Record<string, unknown>));
    ok(res, await sendSmsCode(str(body.mobile)));
  });

  router.post('/api/account/login/sms', async ({ req, res }: Ctx) => {
    const body = await readJson(req).catch(() => ({} as Record<string, unknown>));
    ok(res, await loginWithSms(str(body.mobile), str(body.code), str(body.smsCodeKey)));
  });
  // 上行短信已发送后的「继续验证」：只跑 MFA 校验 + 重试登录，不重新发码
  router.post('/api/account/login/sms/continue', async ({ req, res }: Ctx) => {
    const body = await readJson(req).catch(() => ({} as Record<string, unknown>));
    ok(res, await continueSmsLogin(str(body.mobile), str(body.code)));
  });
  // 弹幕：按播放时间取一段；前端播到接近本页末尾时带 cursor 取下一页
  router.get('/api/danmaku', async ({ res, url }: Ctx) => {
    const seriesId = url.searchParams.get('seriesId') ?? '';
    const episodeId = url.searchParams.get('episodeId') ?? '';
    if (!/^\d{6,25}$/.test(seriesId) || !/^\d{6,25}$/.test(episodeId)) {
      fail(res, 400, 'bad_ids', '剧或集 id 不合法');
      return;
    }
    try {
      ok(
        res,
        await danmakuSlice(
          seriesId,
          episodeId,
          num(url.searchParams.get('startMs'), 0),
          url.searchParams.get('cursor') ?? '',
        ),
      );
    } catch (err) {
      const e = toUserMessage(err);
      fail(res, e.status, e.code, e.message);
    }
  });

  // 短剧评论列表（参考 /novel/commentapi/comment/list/<episode>/v1/）
  router.get('/api/comments', async ({ res, url }: Ctx) => {
    const seriesId = url.searchParams.get('seriesId') ?? '';
    const episodeId = url.searchParams.get('episodeId') ?? '';
    if (!/^\d{6,25}$/.test(seriesId) || !/^\d{6,25}$/.test(episodeId)) {
      fail(res, 400, 'bad_ids', '剧或集 id 不合法');
      return;
    }
    try {
      ok(
        res,
        await fetchComments({
          seriesId,
          episodeId,
          cursor: url.searchParams.get('cursor') ?? '',
          count: num(url.searchParams.get('count'), 20),
          startOffset: num(url.searchParams.get('startOffset'), 0),
          durationMs: num(url.searchParams.get('durationMs'), 0),
        }),
      );
    } catch (err) {
      const e = toUserMessage(err);
      fail(res, e.status, e.code, e.message);
    }
  });

  // 评论回复列表（参考 Replies）
  router.get('/api/replies', async ({ res, url }: Ctx) => {
    const seriesId = url.searchParams.get('seriesId') ?? '';
    const episodeId = url.searchParams.get('episodeId') ?? '';
    const commentId = url.searchParams.get('commentId') ?? '';
    if (!/^\d{6,25}$/.test(seriesId) || !/^\d{6,25}$/.test(episodeId) || !/^\d{6,25}$/.test(commentId)) {
      fail(res, 400, 'bad_ids', '剧/集/评论 id 不合法');
      return;
    }
    try {
      ok(
        res,
        await fetchReplies({
          seriesId,
          episodeId,
          commentId,
          cursor: url.searchParams.get('cursor') ?? '',
          count: num(url.searchParams.get('count'), 10),
        }),
      );
    } catch (err) {
      const e = toUserMessage(err);
      fail(res, e.status, e.code, e.message);
    }
  });

  // 发评论 / 发弹幕（参考 SendComment / SendDanmaku → comment/add/v1/）
  router.post('/api/comment', async ({ req, res }: Ctx) => {
    if (!accountLoggedIn()) {
      fail(res, 401, 'not_logged_in', '请先登录再发评论');
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      fail(res, 400, 'bad_body', '请求体不是合法 JSON');
      return;
    }
    const seriesId = str(body.seriesId);
    const episodeId = str(body.episodeId);
    const text = str(body.text).trim();
    if (!/^\d{6,25}$/.test(seriesId) || !/^\d{6,25}$/.test(episodeId)) {
      fail(res, 400, 'bad_ids', '剧或集 id 不合法');
      return;
    }
    if (text === '' || text.length > 200) {
      fail(res, 400, 'bad_text', '评论内容需在 1-200 字之间');
      return;
    }
    const result = await accountSendComment({ seriesId, episodeId, text });
    if (!result.ok) {
      fail(res, 502, 'comment_failed', result.message);
      return;
    }
    ok(res, { commentId: result.commentId, text });
  });

  router.post('/api/danmaku/send', async ({ req, res }: Ctx) => {
    if (!accountLoggedIn()) {
      fail(res, 401, 'not_logged_in', '请先登录再发弹幕');
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      fail(res, 400, 'bad_body', '请求体不是合法 JSON');
      return;
    }
    const seriesId = str(body.seriesId);
    const episodeId = str(body.episodeId);
    const text = str(body.text).trim();
    if (!/^\d{6,25}$/.test(seriesId) || !/^\d{6,25}$/.test(episodeId)) {
      fail(res, 400, 'bad_ids', '剧或集 id 不合法');
      return;
    }
    if (text === '' || text.length > 100) {
      fail(res, 400, 'bad_text', '弹幕内容需在 1-100 字之间');
      return;
    }
    const result = await accountSendDanmaku({
      seriesId,
      episodeId,
      text,
      offsetMs: numberOr(body.offsetMs, 0),
    });
    if (!result.ok) {
      fail(res, 502, 'danmaku_failed', result.message);
      return;
    }
    ok(res, { commentId: result.commentId, text });
  });

  router.post('/api/comment/delete', async ({ req, res }: Ctx) => {
    if (!accountLoggedIn()) {
      fail(res, 401, 'not_logged_in', '请先登录');
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      fail(res, 400, 'bad_body', '请求体不是合法 JSON');
      return;
    }
    const commentId = str(body.commentId);
    const episodeId = str(body.episodeId);
    if (!/^\d{6,25}$/.test(commentId) || !/^\d{6,25}$/.test(episodeId)) {
      fail(res, 400, 'bad_ids', '评论或集 id 不合法');
      return;
    }
    const result = await accountDeleteComment({
      commentId,
      episodeId,
      dataType: numberOr(body.dataType, 4),
    });
    if (!result.ok) {
      fail(res, 502, 'delete_failed', result.message);
      return;
    }
    ok(res, { ok: true });
  });

  router.post('/api/comment/like', async ({ req, res }: Ctx) => {
    if (!accountLoggedIn()) {
      fail(res, 401, 'not_logged_in', '请先登录');
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      fail(res, 400, 'bad_body', '请求体不是合法 JSON');
      return;
    }
    const commentId = str(body.commentId);
    if (!/^\d{6,25}$/.test(commentId)) {
      fail(res, 400, 'bad_comment_id', '评论 id 不合法');
      return;
    }
    const result = await accountLikeComment(commentId, body.liked === true);
    if (!result.ok) {
      fail(res, 502, 'like_failed', result.message);
      return;
    }
    ok(res, { liked: body.liked === true });
  });

  // 媒体文件：JSON 接口之外，视频必须支持 Range，否则拖进度会整段重下
  router.get('/api/media/:name', ({ req, res, params }: Ctx) => {
    const file = mediaFilePath(params.name ?? '');
    if (file === null) {
      fail(res, 404, 'no_media', '文件不存在');
      return;
    }
    serveMedia(req, res, file);
  });

  /**
   * 官网直连播放：把 360p 的 CDN 地址代理成同源 /api/stream/<集 id>。
   *
   * 为什么不能直接把 CDN 地址丢给 <video>：CDN 对浏览器发的 Referer
   * （http://127.0.0.1:5880/…）返回 403，Node 侧不带 Referer 才 200。
   * 代理之后浏览器只跟 core 说话，顺便把地址过期（403）也在这里重取一次。
   */
  router.get('/api/stream/:episodeId', async ({ req, res, params }: Ctx) => {
    const id = params.episodeId ?? '';
    if (!/^\d{6,25}$/.test(id)) {
      fail(res, 400, 'bad_episode_id', '集 id 不合法');
      return;
    }
    await proxyWebStream(req, res, id, false);
  });

  // ---------------- 进度与追剧 ----------------

  router.post('/api/progress', async ({ req, res }: Ctx) => {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      fail(res, 400, 'bad_body', '请求体不是合法 JSON');
      return;
    }
    const seriesId = str(body.seriesId);
    const episodeId = str(body.episodeId);
    if (!/^\d{6,25}$/.test(seriesId) || !/^\d{6,25}$/.test(episodeId)) {
      fail(res, 400, 'bad_ids', '剧或集 id 不合法');
      return;
    }
    try {
      const episodeNo = numberOr(body.episodeNo, 1);
      const positionSec = numberOr(body.positionSec, 0);
      const durationSec = numberOr(body.durationSec, 0);
      saveProgress({
        seriesId,
        seriesTitle: str(body.seriesTitle, '未命名'),
        cover: str(body.cover),
        episodeId,
        episodeNo,
        positionSec,
        durationSec,
      });
      // 登录后把进度/历史写回账号（节流，不阻塞本地保存）
      if (accountLoggedIn()) {
        const now = Date.now();
        const last = progressUploadAt.get(seriesId) ?? 0;
        if (now - last > 8000) {
          progressUploadAt.set(seriesId, now);
          void accountUploadProgress({ seriesId, episodeId, episodeNo, positionSec, durationSec }).catch(
            () => undefined,
          );
        }
      }
      ok(res, { saved: true });
    } catch (err) {
      fail(res, 500, 'progress_save_failed', (err as Error).message);
    }
  });

  router.get('/api/progress/continue', ({ res, url }: Ctx) => {
    ok(res, listContinue(num(url.searchParams.get('limit'), 12)));
  });

  router.get('/api/progress', ({ res, url }: Ctx) => {
    const seriesId = url.searchParams.get('seriesId') ?? '';
    if (seriesId === '') {
      fail(res, 400, 'no_series', '缺少 seriesId');
      return;
    }
    ok(res, getProgress(seriesId));
  });

  router.post('/api/progress/clear', async ({ req, res }: Ctx) => {
    let body: Record<string, unknown> = {};
    try {
      body = await readJson(req);
    } catch {
      /* 空体 = 清全部 */
    }
    const seriesId = str(body.seriesId);
    ok(res, { removed: clearProgress(seriesId === '' ? undefined : seriesId) });
  });

  router.get('/api/favorites', ({ res, url }: Ctx) => {
    ok(res, listFavorites(num(url.searchParams.get('limit'), 200)));
  });

  // ---------------- 点赞（本地，参考 local_like） ----------------

  router.get('/api/likes', ({ res, url }: Ctx) => {
    ok(res, listLikes(num(url.searchParams.get('limit'), 200)));
  });

  router.get('/api/like/:seriesId', ({ res, params }: Ctx) => {
    ok(res, { liked: isLiked(params.seriesId ?? '') });
  });

  router.post('/api/like', async ({ req, res }: Ctx) => {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      fail(res, 400, 'bad_body', '请求体不是合法 JSON');
      return;
    }
    const seriesId = str(body.seriesId);
    if (!/^\d{6,25}$/.test(seriesId)) {
      fail(res, 400, 'bad_series_id', '剧 id 不合法');
      return;
    }
    const existing = getLike(seriesId);
    const willLike = existing === null;
    const episodeId = str(body.episodeId) !== '' ? str(body.episodeId) : (existing?.episodeId ?? '');
    if (willLike && episodeId === '') {
      fail(res, 400, 'no_episode', '点赞需要具体集 id');
      return;
    }
    // 账号点赞是按集（vid）的，先写账号，成功再改本地
    if (accountLoggedIn()) {
      const write = await accountSetLike(seriesId, episodeId, willLike);
      if (!write.ok) {
        fail(res, 502, 'account_write_failed', `账号点赞失败：${write.message}`);
        return;
      }
    }
    ok(
      res,
      toggleLike({
        seriesId,
        seriesTitle: str(body.seriesTitle, '未命名'),
        cover: str(body.cover),
        episodeCount: numberOr(body.episodeCount, 0),
        episodeId,
      }),
    );
  });

  // ---------------- 追更（本地） ----------------

  router.get('/api/reservations', ({ res, url }: Ctx) => {
    ok(res, listReservations(num(url.searchParams.get('limit'), 200)));
  });

  router.get('/api/follows', async ({ res }: Ctx) => {
    const rows = listFollows();
    // 一次批量取最新集数，判断有没有新集；返回本次的 hasNew，同时把「已确认集数」推到最新
    const counts = await seriesCounts(rows.map((row) => row.seriesId));
    const items = rows.map((row) => {
      const latest = counts.get(row.seriesId);
      const hasNew = latest !== undefined && latest > row.episodeCount;
      if (hasNew && latest !== undefined) updateFollowCount(row.seriesId, latest);
      return { ...row, latestCount: latest ?? row.episodeCount, hasNew };
    });
    ok(res, items);
  });

  router.get('/api/follow/:seriesId', ({ res, params }: Ctx) => {
    ok(res, { following: isFollowing(params.seriesId ?? '') });
  });

  router.post('/api/follow', async ({ req, res }: Ctx) => {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      fail(res, 400, 'bad_body', '请求体不是合法 JSON');
      return;
    }
    const seriesId = str(body.seriesId);
    if (!/^\d{6,25}$/.test(seriesId)) {
      fail(res, 400, 'bad_series_id', '剧 id 不合法');
      return;
    }
    ok(
      res,
      toggleFollow({
        seriesId,
        seriesTitle: str(body.seriesTitle, '未命名'),
        cover: str(body.cover),
        episodeCount: numberOr(body.episodeCount, 0),
      }),
    );
  });

  // ---------------- 设置与缓存 ----------------

  router.get('/api/settings', ({ res }: Ctx) => {
    ok(res, getSettings());
  });

  router.post('/api/settings', async ({ req, res }: Ctx) => {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      fail(res, 400, 'bad_body', '请求体不是合法 JSON');
      return;
    }
    const patch: {
      mediaCacheDir?: string;
      mediaCacheMB?: number;
      downloadDir?: string;
      defaultQuality?: 'auto' | '480p' | '720p' | '1080p';
      downloadConcurrency?: number;
      autoPlayNext?: boolean;
      defaultSpeed?: number;
      skipIntroSec?: number;
      skipOutroSec?: number;
      notifyNewEpisodes?: boolean;
      autoSyncAccount?: boolean;
      enhanceVideo?: 'off' | 'standard' | 'strong';
    } = {};
    if (typeof body.mediaCacheDir === 'string') patch.mediaCacheDir = body.mediaCacheDir;
    if (typeof body.mediaCacheMB === 'number') patch.mediaCacheMB = body.mediaCacheMB;
    if (typeof body.downloadDir === 'string') patch.downloadDir = body.downloadDir;
    if (body.defaultQuality === 'auto' || body.defaultQuality === '480p' || body.defaultQuality === '720p' || body.defaultQuality === '1080p') {
      patch.defaultQuality = body.defaultQuality;
    }
    if (typeof body.downloadConcurrency === 'number') patch.downloadConcurrency = body.downloadConcurrency;
    if (typeof body.autoPlayNext === 'boolean') patch.autoPlayNext = body.autoPlayNext;
    if (typeof body.defaultSpeed === 'number') patch.defaultSpeed = body.defaultSpeed;
    if (typeof body.skipIntroSec === 'number') patch.skipIntroSec = body.skipIntroSec;
    if (typeof body.skipOutroSec === 'number') patch.skipOutroSec = body.skipOutroSec;
    if (typeof body.notifyNewEpisodes === 'boolean') patch.notifyNewEpisodes = body.notifyNewEpisodes;
    if (typeof body.autoSyncAccount === 'boolean') patch.autoSyncAccount = body.autoSyncAccount;
    if (body.enhanceVideo === 'off' || body.enhanceVideo === 'standard' || body.enhanceVideo === 'strong') {
      patch.enhanceVideo = body.enhanceVideo;
    }
    ok(res, updateSettings(patch));
  });

  router.get('/api/cache', async ({ res }: Ctx) => {
    const media = await mediaCacheStats();
    ok(res, { media, images: imageCacheStats(), settings: getSettings() });
  });

  router.post('/api/cache/clear', async ({ req, res }: Ctx) => {
    let target = 'all';
    try {
      const body = await readJson(req);
      if (typeof body.target === 'string') target = body.target;
    } catch {
      /* 空体 = 全清 */
    }
    const media = target === 'images' ? { removed: 0, bytes: 0 } : await clearMediaCache();
    const images = target === 'media' ? { removed: 0, bytes: 0 } : await clearImageCache();
    log.info(`清理缓存 target=${target} 视频 ${media.removed} 个，图片 ${images.removed} 个`);
    ok(res, { media, images });
  });

  router.get('/api/favorite/:seriesId', ({ res, params }: Ctx) => {
    ok(res, { favorite: isFavorite(params.seriesId ?? '') });
  });

  router.post('/api/favorite', async ({ req, res }: Ctx) => {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      fail(res, 400, 'bad_body', '请求体不是合法 JSON');
      return;
    }
    const seriesId = str(body.seriesId);
    if (!/^\d{6,25}$/.test(seriesId)) {
      fail(res, 400, 'bad_series_id', '剧 id 不合法');
      return;
    }
    const input = {
      seriesId,
      seriesTitle: str(body.seriesTitle, '未命名'),
      cover: str(body.cover),
      episodeCount: numberOr(body.episodeCount, 0),
    };
    const result = toggleFavorite(input);
    if (accountLoggedIn()) {
      const write = await accountSetFavorite(seriesId, result.added);
      if (!write.ok) {
        toggleFavorite(input); // 账号没写成功就回滚本地，避免两边不一致
        fail(res, 502, 'account_write_failed', `账号收藏失败：${write.message}`);
        return;
      }
    }
    ok(res, result);
  });

  // 预约 / 取消预约（登录后写账号，本地同步记录）
  router.post('/api/reservation', async ({ req, res }: Ctx) => {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      fail(res, 400, 'bad_body', '请求体不是合法 JSON');
      return;
    }
    const seriesId = str(body.seriesId);
    if (!/^\d{6,25}$/.test(seriesId)) {
      fail(res, 400, 'bad_series_id', '剧 id 不合法');
      return;
    }
    const reserve = body.reserve !== false;
    if (accountLoggedIn()) {
      const write = await accountSetReservation(seriesId, reserve);
      if (!write.ok) {
        fail(res, 502, 'account_write_failed', `账号预约失败：${write.message}`);
        return;
      }
    }
    if (reserve) {
      addReservation({
        seriesId,
        seriesTitle: str(body.seriesTitle, '未命名'),
        cover: str(body.cover),
        episodeCount: numberOr(body.episodeCount, 0),
        online: false,
        updatedAt: Date.now(),
      });
    } else {
      removeReservation(seriesId);
    }
    ok(res, { reserved: reserve });
  });
}

const STREAM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 把上游 mp4 透传给浏览器，保留 Range/206 语义；403（地址过期）时重取一次。 */
async function proxyWebStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  episodeId: string,
  retried: boolean,
): Promise<void> {
  const stream = retried ? await refreshWebStream(episodeId) : await resolveWebStream(episodeId);
  if (stream === null) {
    fail(res, 502, 'no_stream', '上游暂时取不到这一集的播放地址');
    return;
  }
  const headers: Record<string, string> = { 'user-agent': STREAM_UA, accept: '*/*' };
  const range = req.headers.range;
  if (typeof range === 'string' && range !== '') headers.range = range;

  let upstream: Response;
  try {
    upstream = await fetch(stream.url, { headers, signal: AbortSignal.timeout(180_000) });
  } catch (err) {
    fail(res, 502, 'stream_failed', (err as Error).message);
    return;
  }

  if (upstream.status === 403 && !retried) {
    await upstream.body?.cancel().catch(() => undefined);
    log.info(`直连 403，重取地址 ${episodeId}`);
    await proxyWebStream(req, res, episodeId, true);
    return;
  }
  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => undefined);
    res.writeHead(upstream.status, { 'cache-control': 'no-store' });
    res.end();
    return;
  }

  const out: Record<string, string> = {};
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name);
    if (value !== null && value !== '') out[name] = value;
  }
  out['cache-control'] = 'no-store';
  res.writeHead(upstream.status, out);

  if (req.method === 'HEAD' || upstream.body === null) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  let closed = false;
  res.on('close', () => {
    closed = true;
    void reader.cancel().catch(() => undefined);
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || closed) break;
      if (value !== undefined && !res.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => res.once('drain', resolve));
      }
    }
  } catch {
    /* 客户端拖动/关闭会中断，正常现象 */
  }
  if (!closed) res.end();
}

/** Range/206：绝不伪造，只有客户端真的发了 Range 才回 206。 */
function serveMedia(req: http.IncomingMessage, res: http.ServerResponse, file: string): void {
  const total = fs.statSync(file).size;
  const range = req.headers.range;

  if (range === undefined) {
    res.writeHead(200, {
      'content-type': 'video/mp4',
      'content-length': total,
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=86400',
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  const startRaw = m?.[1] ?? '';
  const endRaw = m?.[2] ?? '';
  if (m === null || (startRaw === '' && endRaw === '')) {
    res.writeHead(416, { 'content-range': `bytes */${total}` });
    res.end();
    return;
  }

  let start = startRaw === '' ? Number.NaN : Number.parseInt(startRaw, 10);
  let end = endRaw === '' ? Number.NaN : Number.parseInt(endRaw, 10);
  if (Number.isNaN(start)) {
    // bytes=-N：取末尾 N 字节
    const suffix = Number.isNaN(end) ? 0 : end;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else if (Number.isNaN(end)) {
    end = total - 1;
  }
  end = Math.min(end, total - 1);

  if (start > end || start >= total) {
    res.writeHead(416, { 'content-range': `bytes */${total}` });
    res.end();
    return;
  }

  res.writeHead(206, {
    'content-type': 'video/mp4',
    'content-length': end - start + 1,
    'content-range': `bytes ${start}-${end}/${total}`,
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=86400',
  });
  fs.createReadStream(file, { start, end }).pipe(res);
}
