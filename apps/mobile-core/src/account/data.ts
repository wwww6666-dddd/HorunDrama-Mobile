/**
 * 账号数据同步：书架（收藏）、观看历史、预约。
 *
 * 这些接口和内容接口不是同一套：要带会话 Cookie + 账号设备 + hgsigner 签名，
 * 主机是 api5-normal-sinfonlinea（见 verifySession 的实测）。
 */
import { createLogger } from '../util/log.ts';
import { normalizeCover } from '../sources/client.ts';
import { readDevice, readSession } from './session.ts';
import {
  replaceReservations,
  upsertFavoriteAt,
  upsertFollowAt,
  upsertProgressAt,
  type ReservationInput,
} from '../store/progress.ts';

const log = createLogger('account-sync');

const ACCOUNT_HOST = 'https://api5-normal-sinfonlinea.fqnovel.com';

function signerUrl(): string {
  return process.env.HORUN_SIGNER_URL ?? process.env.YIMU_SIGNER_URL ?? 'http://127.0.0.1:8791/sign';
}

interface AccountDevice {
  device_id?: string;
  install_id?: string;
  cdid?: string;
  channel?: string;
  device_brand?: string;
  device_type?: string;
  os_version?: string;
  os_api?: string;
  resolution?: string;
  dpi?: string;
  user_agent?: string;
}

function baseQuery(device: AccountDevice): Record<string, string> {
  const now = Date.now();
  return {
    _rticket: String(now),
    ac: 'wifi',
    aid: '8662',
    app_name: 'novelread',
    cdid: String(device.cdid ?? ''),
    channel: String(device.channel ?? ''),
    compliance_status: '0',
    device_brand: String(device.device_brand ?? 'xiaomi').toLowerCase(),
    device_id: String(device.device_id ?? ''),
    device_platform: 'android',
    device_type: String(device.device_type ?? '23127PN0CC'),
    dpi: String(device.dpi ?? '460'),
    dragon_device_type: 'phone',
    host_abi: 'arm64-v8a',
    iid: String(device.install_id ?? ''),
    is_android_pad_screen: '0',
    language: 'zh',
    manifest_version_code: '73932',
    need_personal_recommend: '1',
    os: 'android',
    os_api: String(device.os_api ?? '34'),
    os_version: String(device.os_version ?? '14'),
    player_so_load: '1',
    pv_player: '73932',
    resolution: String(device.resolution ?? '1200*2670'),
    ssmix: 'a',
    ts: String(Math.floor(now / 1000)),
    update_version_code: '73932',
    version_code: '73932',
    version_name: '7.3.9.32',
  };
}

/** 带签名 GET 一个账号接口；返回原始文本（历史接口里的 vid 是 64 位数字，先别 JSON.parse）。 */
async function signedGetRaw(pathname: string, extra: Record<string, string>): Promise<string> {
  const session = readSession();
  const device = (readDevice() ?? {}) as AccountDevice;
  if (session.cookie === '') throw new Error('没有登录会话');

  const query = { ...baseQuery(device), ...extra };
  const pairs = Object.entries(query).map(([k, v]) => [k, String(v)]);
  const signed = await fetch(signerUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: pathname,
      query: pairs,
      body: '',
      deviceId: String(device.device_id ?? ''),
      version: '7.3.9.32',
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!signed.ok) throw new Error(`签名服务不可用（HTTP ${signed.status}）`);
  const sig = (await signed.json()) as { query?: string; headers?: Record<string, string> };

  const res = await fetch(`${ACCOUNT_HOST}${pathname}?${sig.query ?? ''}`, {
    headers: {
      ...(sig.headers ?? {}),
      cookie: session.cookie,
      'user-agent': String(device.user_agent ?? 'com.phoenix.read/73932'),
      ...(session.token !== '' ? { 'x-tt-token': session.token } : {}),
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(20000),
  });
  return res.text();
}

async function signedGet(pathname: string, extra: Record<string, string>): Promise<Record<string, unknown>> {
  const text = await signedGetRaw(pathname, extra);
  const body = JSON.parse(text) as { code?: number; message?: string; data?: Record<string, unknown> };
  if (body.code !== 0) throw new Error(`账号接口 code=${String(body.code)} ${body.message ?? ''}`.trim());
  return body.data ?? {};
}

export interface AccountHistoryItem {
  seriesId: string;
  title: string;
  cover: string;
  episodeId: string;
  episodeNo: number;
  positionSec: number;
  durationSec: number;
  updatedAt: number;
}

export interface AccountFavoriteItem {
  seriesId: string;
  title: string;
  cover: string;
  episodeCount: number;
  updatedAt: number;
}

export interface AccountFollowItem {
  seriesId: string;
  title: string;
  cover: string;
  episodeCount: number;
  updatedAt: number;
}

export interface AccountReservationItem {
  seriesId: string;
  title: string;
  cover: string;
  episodeCount: number;
  online: boolean;
}

export interface SyncResult {
  ok: boolean;
  history: number;
  favorites: number;
  follows: number;
  reservations: number;
  message: string;
  at: number;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function fetchHistory(): Promise<AccountHistoryItem[]> {
  const text = await signedGetRaw('/reading/bookapi/read_history/list/v', {
    book_type: '2',
    full_field: 'false',
    is_first_load: 'true',
    last_min_read_timestamp_ms: '0',
    limit: '0',
    offset: '0',
    query_soft_deleted: 'false',
  });
  // vid 是 19 位数字，JSON.parse 会丢精度；先把它变成字符串再解析
  const safe = text.replace(/"vid":(\d+)/g, '"vid":"$1"');
  const parsed = JSON.parse(safe) as { code?: number; message?: string; data?: Record<string, unknown> };
  if (parsed.code !== 0) throw new Error(`历史接口 code=${String(parsed.code)}`);
  const data = parsed.data ?? {};
  const list = Array.isArray(data.data_list) ? (data.data_list as Array<Record<string, unknown>>) : [];
  const items: AccountHistoryItem[] = [];
  for (const row of list) {
    const seriesId = str(row.book_id_str) !== '' ? str(row.book_id_str) : String(num(row.book_id));
    const episodeId = str(row.vid) !== '' ? str(row.vid) : String(num(row.vid));
    if (seriesId === '' || episodeId === '0') continue;
    items.push({
      seriesId,
      title: str(row.book_name),
      cover: normalizeCover(str(row.thumb_url)),
      episodeId,
      episodeNo: num(row.vid_index) + 1,
      // 历史里 position 是毫秒，duration 是微秒（实测 54132191 → 54s）
      positionSec: num(row.current_play_position) / 1000,
      durationSec: num(row.duration) / 1_000_000,
      updatedAt: num(row.read_timestamp_ms),
    });
  }
  return items;
}

/** 单部剧的账号续播位置。 */
export interface AccountResume {
  seriesId: string;
  episodeId: string;
  episodeNo: number;
  positionSec: number;
  durationSec: number;
  updatedAt: number;
}

/** 退出登录时清掉账号数据缓存，避免内存里还留着历史。 */
export function clearAccountCaches(): void {
  resumeCache = null;
}

let resumeCache: { at: number; items: AccountHistoryItem[] } | null = null;

/** 从账号历史里取这部剧的续播点；整份历史缓存 60 秒，避免每次播放都拉 400KB。 */
export async function accountResumeFor(seriesId: string): Promise<AccountResume | null> {
  if (readSession().cookie === '') return null;
  const now = Date.now();
  if (resumeCache === null || now - resumeCache.at > 60_000) {
    resumeCache = { at: now, items: await fetchHistory() };
  }
  const item = resumeCache.items.find((row) => row.seriesId === seriesId);
  if (item === undefined) return null;
  return {
    seriesId: item.seriesId,
    episodeId: item.episodeId,
    episodeNo: item.episodeNo,
    positionSec: item.positionSec,
    durationSec: item.durationSec > item.positionSec ? item.durationSec : 0,
    updatedAt: item.updatedAt,
  };
}

async function fetchFavorites(): Promise<AccountFavoriteItem[]> {
  const data = await signedGet('/reading/bookapi/bookshelf/video/info/v', {
    count: '50',
    offset: '0',
    target_user_id: '',
  });
  const list = Array.isArray(data.video_shelf_info)
    ? (data.video_shelf_info as Array<Record<string, unknown>>)
    : [];
  const items: AccountFavoriteItem[] = [];
  for (const row of list) {
    const video = (row.video_data ?? {}) as Record<string, unknown>;
    const seriesId = str(video.series_id);
    if (seriesId === '') continue;
    items.push({
      seriesId,
      title: str(row.series_title),
      cover: normalizeCover(str(row.series_cover_url)),
      episodeCount: num(video.episode_cnt),
      updatedAt: num(row.last_operate_time) > 0 ? num(row.last_operate_time) * 1000 : num(row.collect_time),
    });
  }
  return items;
}

/** 订阅列表（追更）：账号里「追更/订阅」的剧，用来补本地 follow 表。 */
async function fetchSubscriptions(): Promise<AccountFollowItem[]> {
  const data = await signedGet('/reading/user/subscribe/list/v1/', {
    active_panel: '6',
    gender_type: '2',
    need_calendar_schema: 'false',
    offset: '0',
    tab_style: '2',
    tab_type: '5',
    target_date: '',
  });
  const list = Array.isArray(data.subscribe_items)
    ? (data.subscribe_items as Array<Record<string, unknown>>)
    : [];
  const items: AccountFollowItem[] = [];
  for (const row of list) {
    const sub = (row.subscribe_data ?? {}) as Record<string, unknown>;
    const seriesId = str(sub.series_id);
    if (seriesId === '') continue;
    items.push({
      seriesId,
      title: str(sub.title),
      cover: normalizeCover(str(sub.cover)),
      episodeCount: num(sub.episode_cnt),
      updatedAt: Date.now(),
    });
  }
  return items;
}

/** 预约列表：subscribe/list 的 action_channel=9 返回「待上线/预约」条目。 */
async function fetchReservations(): Promise<AccountReservationItem[]> {
  const text = await signedGetRaw('/reading/user/subscribe/list/v1/', {
    action_channel: '9',
    cursor_str: '',
    need_calendar_schema: 'false',
  });
  const parsed = JSON.parse(text) as { code?: number; data?: Record<string, unknown> };
  if (parsed.code !== 0) throw new Error(`预约列表 code=${String(parsed.code)}`);
  const list = Array.isArray(parsed.data?.subscribe_items)
    ? (parsed.data.subscribe_items as Array<Record<string, unknown>>)
    : [];
  const items: AccountReservationItem[] = [];
  for (const row of list) {
    const seriesId = str(row.item_id);
    if (seriesId === '' || row.has_subscribed === false) continue;
    items.push({
      seriesId,
      title: str(row.name),
      cover: normalizeCover(str(row.cover)),
      episodeCount: 0,
      online: row.is_online === true,
    });
  }
  return items;
}

let lastSyncAt = 0;
let inFlight: Promise<SyncResult> | null = null;

/** 同步账号数据（收藏 / 历史 / 追更订阅）。10 分钟内重复调用直接返回上次结果。 */
export function syncAccountData(force = false): Promise<SyncResult> {
  if (inFlight !== null) return inFlight;
  if (!force && lastSyncAt > 0 && Date.now() - lastSyncAt < 10 * 60_000) {
    return Promise.resolve({
      ok: true,
      history: 0,
      favorites: 0,
      follows: 0,
      reservations: 0,
      message: '刚刚同步过',
      at: lastSyncAt,
    });
  }
  inFlight = (async () => {
    const errors: string[] = [];
    let history = 0;
    let favorites = 0;
    let follows = 0;
    let reservations = 0;

    try {
      const items = await fetchHistory();
      for (const item of items) {
        if (
          upsertProgressAt({
            seriesId: item.seriesId,
            seriesTitle: item.title,
            cover: item.cover,
            episodeId: item.episodeId,
            episodeNo: item.episodeNo,
            positionSec: item.positionSec,
            durationSec: item.durationSec > item.positionSec ? item.durationSec : 0,
            updatedAt: item.updatedAt,
          })
        ) {
          history += 1;
        }
      }
    } catch (err) {
      errors.push(`历史：${(err as Error).message}`);
    }

    try {
      const items = await fetchFavorites();
      for (const item of items) {
        if (
          upsertFavoriteAt({
            seriesId: item.seriesId,
            seriesTitle: item.title,
            cover: item.cover,
            episodeCount: item.episodeCount,
            updatedAt: item.updatedAt,
          })
        ) {
          favorites += 1;
        }
      }
    } catch (err) {
      errors.push(`收藏：${(err as Error).message}`);
    }

    try {
      const items = await fetchSubscriptions();
      for (const item of items) {
        if (
          upsertFollowAt({
            seriesId: item.seriesId,
            seriesTitle: item.title,
            cover: item.cover,
            episodeCount: item.episodeCount,
            updatedAt: item.updatedAt,
          })
        ) {
          follows += 1;
        }
      }
    } catch (err) {
      errors.push(`追更：${(err as Error).message}`);
    }

    try {
      const items = await fetchReservations();
      const rows: ReservationInput[] = items.map((item) => ({
        seriesId: item.seriesId,
        seriesTitle: item.title,
        cover: item.cover,
        episodeCount: item.episodeCount,
        online: item.online,
        updatedAt: Date.now(),
      }));
      reservations = replaceReservations(rows);
    } catch (err) {
      errors.push(`预约：${(err as Error).message}`);
    }

    lastSyncAt = Date.now();
    const ok = errors.length === 0;
    const message = ok
      ? `同步完成：历史 ${history} 条 / 收藏 ${favorites} 部 / 追更 ${follows} 部 / 预约 ${reservations} 部`
      : `部分同步失败：${errors.join('；')}`;
    log.info(message);
    return { ok, history, favorites, follows, reservations, message, at: lastSyncAt };
  })();
  try {
    return inFlight;
  } finally {
    void inFlight.finally(() => {
      inFlight = null;
    });
  }
}

/** 供调试：把最近一次同步时间读出来。 */
export function lastSyncTime(): number {
  return lastSyncAt;
}
