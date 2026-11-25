/**
 * 短剧评论列表。
 *
 * 参考实现：Comments(seriesId, episodeId, cursor) → POST
 * /novel/commentapi/comment/list/<episodeId>/v1/（lq 主机），body 里带
 * book_id/playlet_item_duration/start_offset_time/group_id/comment_type 等。
 */
import { readDevice, readSession } from '../account/session.ts';
import { fetchAccountProfile } from '../account/profile.ts';
import { createLogger } from '../util/log.ts';
import { TtlCache } from '../util/cache.ts';

const log = createLogger('comments');

const COMMENT_HOST = 'https://api5-normal-lq.fqnovel.com';
const REPLY_HOST = 'https://api5-normal-lq.fqnovel.com';

export interface CommentUser {
  userId: string;
  name: string;
  avatar: string;
}

export interface CommentItem {
  id: string;
  text: string;
  user: CommentUser;
  likeCount: number;
  liked: boolean;
  replyCount: number;
  createTime: number;
  offsetTime: number;
}

export interface CommentPage {
  items: CommentItem[];
  cursor: string;
  hasMore: boolean;
  total: number;
}

const cache = new TtlCache<CommentPage>(96, 45_000);

function signerUrl(): string {
  return process.env.HORUN_SIGNER_URL ?? process.env.YIMU_SIGNER_URL ?? 'http://127.0.0.1:8791/sign';
}

interface Device {
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

function baseQuery(device: Device): Record<string, string> {
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

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0;
}

export function fetchComments(input: {  seriesId: string;
  episodeId: string;
  cursor?: string;
  count?: number;
  startOffset?: number;
  durationMs?: number;
}): Promise<CommentPage> {
  const cursor = input.cursor ?? '';
  const count = input.count ?? 20;
  const key = `comments:${input.episodeId}:${cursor}:${count}`;
  return cache.wrap(key, async () => {
    const session = readSession();
    const device = (readDevice() ?? {}) as Device;
    const path = `/novel/commentapi/comment/list/${input.episodeId}/v1/`;
    const body = JSON.stringify({
      aid: 8662,
      business_param: {
        book_id: input.seriesId,
        need_count: true,
        req_type: 0,
      },
      comment_source: 4,
      comment_type: 4,
      compliance_status: 0,
      count,
      cursor,
      group_id: input.episodeId,
      group_type: 30,
      server_channel: 18,
      sort: 1,
    });

    const pairs = Object.entries(baseQuery(device)).map(([k, v]) => [k, String(v)]);
    const signed = await fetch(signerUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path,
        query: pairs,
        body,
        deviceId: String(device.device_id ?? ''),
        version: '7.3.9.32',
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!signed.ok) throw new Error(`签名服务不可用（HTTP ${signed.status}）`);
    const sig = (await signed.json()) as { query?: string; headers?: Record<string, string> };

    const res = await fetch(`${COMMENT_HOST}${path}?${sig.query ?? ''}`, {
      method: 'POST',
      headers: {
        ...(sig.headers ?? {}),
        ...(session.cookie !== '' ? { cookie: session.cookie } : {}),
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': String(device.user_agent ?? 'com.phoenix.read/73932'),
      },
      body,
      signal: AbortSignal.timeout(20000),
    });
    const json = (await res.json()) as {
      code?: number;
      message?: string;
      data?: { data_list?: Array<Record<string, unknown>>; common_list_info?: Record<string, unknown> };
    };
    if (json.code !== 0) throw new Error(`评论接口 code=${String(json.code)} ${json.message ?? ''}`.trim());

    const list = json.data?.data_list ?? [];
    const items: CommentItem[] = [];
    for (const row of list) {
      const comment = (row.comment ?? {}) as Record<string, unknown>;
      const common = (comment.common ?? {}) as Record<string, unknown>;
      const content = (common.content ?? {}) as Record<string, unknown>;
      const userInfo = (common.user_info ?? {}) as Record<string, unknown>;
      const base = (userInfo.base_info ?? {}) as Record<string, unknown>;
      const stat = (comment.stat ?? {}) as Record<string, unknown>;
      const action = (comment.user_action ?? {}) as Record<string, unknown>;
      const expand = (comment.expand ?? {}) as Record<string, unknown>;
      const userId = str(userInfo.user_id);
      items.push({
        id: str(comment.comment_id),
        text: str(content.text),
        user: {
          userId,
          name: str(base.name) !== '' ? str(base.name) : userId !== '' ? `用户${userId.slice(-4)}` : '匿名用户',
          avatar: str(base.avatar_url),
        },
        likeCount: num(stat.digg_count),
        liked: action.user_digg === true,
        replyCount: num(stat.reply_count),
        createTime: num(common.create_timestamp),
        offsetTime: num(expand.offset_time),
      });
    }

    const info = json.data?.common_list_info ?? {};
    // 评论列表自带的 base_info 是空的，按 userId 补真实昵称/头像（带缓存）
    const uniqueUsers = [...new Set(items.map((item) => item.user.userId).filter((id) => id !== ''))];
    const profiles = new Map<string, { name: string; avatar: string }>();
    for (let i = 0; i < uniqueUsers.length; i += 6) {
      await Promise.all(
        uniqueUsers.slice(i, i + 6).map(async (id) => {
          const profile = await fetchAccountProfile(id);
          if (profile !== null) profiles.set(id, { name: profile.name, avatar: profile.avatar });
        }),
      );
    }
    for (const item of items) {
      const profile = profiles.get(item.user.userId);
      if (profile !== undefined) {
        item.user.name = profile.name;
        item.user.avatar = profile.avatar;
      }
    }

    const result: CommentPage = {
      items,
      cursor: str(info.cursor),
      hasMore: info.has_more === true,
      total: num(info.total),
    };
    log.info(`评论 ${input.episodeId}：${items.length} 条，hasMore=${String(result.hasMore)}`);
    return result;
  });
}

/** 评论回复列表（参考 Replies → /commentapi/reply/list/<commentId>/v1/）。 */
export function fetchReplies(input: {
  seriesId: string;
  episodeId: string;
  commentId: string;
  cursor?: string;
  count?: number;
}): Promise<CommentPage> {
  const cursor = input.cursor ?? '';
  const count = input.count ?? 10;
  const key = `replies:${input.commentId}:${cursor}:${count}`;
  return cache.wrap(key, async () => {
    const session = readSession();
    const device = (readDevice() ?? {}) as Device;
    const path = `/novel/commentapi/reply/list/${input.commentId}/v1/`;
    const body = JSON.stringify({
      aid: 8662,
      business_param: { book_id: input.seriesId, need_count: false },
      comment_id: input.commentId,
      comment_source: 504,
      comment_type: 4,
      compliance_status: 0,
      count,
      cursor,
      group_id: input.episodeId,
      group_type: 30,
      server_channel: 18,
    });

    const pairs = Object.entries(baseQuery(device)).map(([k, v]) => [k, String(v)]);
    const signed = await fetch(signerUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path,
        query: pairs,
        body,
        deviceId: String(device.device_id ?? ''),
        version: '7.3.9.32',
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!signed.ok) throw new Error(`签名服务不可用（HTTP ${signed.status}）`);
    const sig = (await signed.json()) as { query?: string; headers?: Record<string, string> };

    const res = await fetch(`${REPLY_HOST}${path}?${sig.query ?? ''}`, {
      method: 'POST',
      headers: {
        ...(sig.headers ?? {}),
        ...(session.cookie !== '' ? { cookie: session.cookie } : {}),
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': String(device.user_agent ?? 'com.phoenix.read/73932'),
      },
      body,
      signal: AbortSignal.timeout(20000),
    });
    const json = (await res.json()) as {
      code?: number;
      message?: string;
      data?: {
        reply_list?: Array<Record<string, unknown>>;
        comment_list_info?: Record<string, unknown>;
      };
    };
    if (json.code !== 0) throw new Error(`回复接口 code=${String(json.code)} ${json.message ?? ''}`.trim());

    const items: CommentItem[] = [];
    for (const row of json.data?.reply_list ?? []) {
      const common = (row.Common ?? {}) as Record<string, unknown>;
      const content = (common.content ?? {}) as Record<string, unknown>;
      const userInfo = (common.user_info ?? {}) as Record<string, unknown>;
      const base = (userInfo.base_info ?? {}) as Record<string, unknown>;
      const stat = (row.stat ?? {}) as Record<string, unknown>;
      const action = (row.user_action ?? {}) as Record<string, unknown>;
      const userId = str(userInfo.user_id);
      const avatar = str(base.expand_user_avatar) !== '' ? str(base.expand_user_avatar) : str(base.user_avatar);
      items.push({
        id: str(row.reply_id),
        text: str(content.text),
        user: {
          userId,
          name: str(base.user_name) !== '' ? str(base.user_name) : userId !== '' ? `用户${userId.slice(-4)}` : '匿名用户',
          avatar: avatar.startsWith('http://') ? `https://${avatar.slice(7)}` : avatar,
        },
        likeCount: num(stat.digg_count),
        liked: action.user_digg === true,
        replyCount: 0,
        createTime: num(common.create_timestamp),
        offsetTime: 0,
      });
    }

    const info = json.data?.comment_list_info ?? {};
    return {
      items,
      cursor: str(info.cursor),
      hasMore: info.has_more === true,
      total: num(info.total),
    };
  });
}
