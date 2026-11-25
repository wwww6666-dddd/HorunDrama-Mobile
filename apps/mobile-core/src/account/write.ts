/**
 * 账号写操作：收藏 / 点赞 / 预约 / 观看进度上传。
 *
 * 这些接口都要「会话 Cookie + 账号设备 + hgsigner 签名」；body 用 JSON（
 * 官方客户端会再 gzip，但实测未压缩也接受）。收藏/预约在 sinfonlinea，
 * 观看历史/进度在 lq。
 */
import { createLogger } from '../util/log.ts';
import { readDevice, readSession } from './session.ts';

const log = createLogger('account-write');

const ACCOUNT_HOST = 'https://api5-normal-sinfonlinea.fqnovel.com';
const CONTENT_HOST = 'https://api5-normal-lq.fqnovel.com';

export interface WriteResult {
  ok: boolean;
  code: number;
  message: string;
  data?: unknown;
}

function signerUrl(): string {
  return process.env.HORUN_SIGNER_URL ?? process.env.YIMU_SIGNER_URL ?? 'http://127.0.0.1:8791/sign';
}

export function accountLoggedIn(): boolean {
  return readSession().cookie !== '';
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

async function signedPostBody(host: string, pathname: string, body: string): Promise<WriteResult> {
  const session = readSession();
  if (session.cookie === '') return { ok: false, code: -1, message: '未登录' };
  const device = (readDevice() ?? {}) as AccountDevice;
  const pairs = Object.entries(baseQuery(device)).map(([k, v]) => [k, String(v)]);

  try {
    const signed = await fetch(signerUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: pathname,
        query: pairs,
        body,
        deviceId: String(device.device_id ?? ''),
        version: '7.3.9.32',
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!signed.ok) return { ok: false, code: -2, message: `签名服务不可用（HTTP ${signed.status}）` };
    const sig = (await signed.json()) as { query?: string; headers?: Record<string, string> };

    const res = await fetch(`${host}${pathname}?${sig.query ?? ''}`, {
      method: 'POST',
      headers: {
        ...(sig.headers ?? {}),
        cookie: session.cookie,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': String(device.user_agent ?? 'com.phoenix.read/73932'),
        ...(session.token !== '' ? { 'x-tt-token': session.token } : {}),
      },
      body,
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = null;
    }
    const code = typeof json?.code === 'number' ? json.code : res.status;
    const message = String(json?.message ?? `HTTP ${res.status}`);
    if (code !== 0) log.warn(`${pathname} 失败 code=${String(code)} ${message}`);
    return { ok: code === 0, code, message, data: json?.data };
  } catch (err) {
    log.warn(`${pathname} 异常：${(err as Error).message}`);
    return { ok: false, code: -3, message: (err as Error).message };
  }
}

async function signedPost(host: string, pathname: string, payload: unknown): Promise<WriteResult> {
  return signedPostBody(host, pathname, JSON.stringify(payload));
}

/** 收藏 / 取消收藏（video_shelf_operate_type 0 收藏 1 取消）。 */
export function accountSetFavorite(seriesId: string, favorite: boolean): Promise<WriteResult> {
  return signedPost(ACCOUNT_HOST, '/reading/bookapi/bookshelf/video/update/v', {
    is_cancelled: false,
    shark_extra: {
      enter_from: 'MainFragmentActivity',
      inactive_type: '0',
      is_active_behavior: 'true',
      page_list: 'MainFragmentActivity',
      previous_page: '',
    },
    update_bookshelf_video_list: [
      { book_id: seriesId, book_type: 2, modify_time: Date.now(), video_shelf_operate_type: favorite ? 0 : 1 },
    ],
  });
}

/** 点赞 / 取消点赞（action_type 3=赞，4=取消）。 */
export function accountSetLike(seriesId: string, episodeId: string, liked: boolean): Promise<WriteResult> {
  return signedPost(ACCOUNT_HOST, '/novel/articleapi/do_action/v1/', {
    action_category: 1,
    action_reason_remark: 'like_click',
    action_type: liked ? 3 : 4,
    business_param: {
      book_id: 0,
      has_aigc_content: false,
      modify_count: 0,
      shark_param: { enter_from: 'MainFragmentActivity', page_list: 'MainFragmentActivity', previous_page: '' },
      video_id: seriesId,
    },
    object_id: episodeId,
    object_type: 6,
  });
}

/** 预约 / 取消预约（op_type 1=预约 2=取消）。 */
export function accountSetReservation(seriesId: string, reserve: boolean): Promise<WriteResult> {
  // item_id 是 19 位数字，不能用 Number（会丢精度），直接拼进 JSON
  const body = JSON.stringify({
    item_id: '__ITEM_ID__',
    item_type: 1,
    op_type: reserve ? 1 : 2,
    shark_param: {
      enter_from: 'BulletActivity',
      page_list: 'MainFragmentActivity,BulletActivity',
      previous_page: 'MainFragmentActivity',
    },
    wish_list_all_del: 0,
  }).replace('"__ITEM_ID__"', seriesId);
  return signedPostBody(ACCOUNT_HOST, '/reading/bookapi/search/uncover_subscribe/v', body);
}

/** 观看历史 + 进度上传（内容接口，lq 主机）。 */
export async function accountUploadProgress(input: {
  seriesId: string;
  episodeId: string;
  episodeNo: number;
  positionSec: number;
  durationSec: number;
}): Promise<WriteResult> {
  const now = Date.now();
  const positionMs = Math.max(0, Math.round(input.positionSec * 1000));

  // book_id / vid 都是 19 位数字：不能用 Number，否则 JSON 里会变成 …401000
  const historyBody = JSON.stringify({
    update_datas: [
      {
        book_id: '__BOOK_ID__',
        book_type: 2,
        chapter_index: 0,
        current_play_position: positionMs,
        digged_count: 0,
        duration: 0,
        episode_cnt: 0,
        is_delete: false,
        is_interactive_game: false,
        is_listen_mode: false,
        is_multi_season: 0,
        meet_guide_comment_tag: false,
        origin_novel_book_id: 0,
        player_accumulate_total_time: positionMs,
        read_timestamp_ms: now,
        recent_reads: 0,
        retain_video_play_time: 0,
        season_index: 0,
        series_play_cnt: 0,
        tone_id: 0,
        update_timestamp_ms: now,
        use_soft_delete: false,
        user_digg: false,
        user_playlet_comment_flag: false,
        vid: '__VID__',
        vid_index: Math.max(0, input.episodeNo - 1),
      },
    ],
  })
    .replace('"__BOOK_ID__"', input.seriesId)
    .replace('"__VID__"', input.episodeId);
  const history = await signedPostBody(CONTENT_HOST, '/reading/bookapi/read_history/update/v', historyBody);
  if (!history.ok) return history;

  return signedPost(CONTENT_HOST, '/reading/bookapi/read_progress/upload/v', {
    books: [
      {
        book_id: input.seriesId,
        book_type: 2,
        channel_id: 0,
        check_timestamp: false,
        cur_channel_id: 0,
        current_play_time: positionMs,
        is_listen_mode: false,
        is_local_book: false,
        item_id: input.episodeId,
        listen_and_read: false,
        page_index: 0,
        page_progress_rate: 0,
        paragraph_offset: 0,
        player_cumulative_total_duration: positionMs,
        progress_type: 0,
        read_timestamp_ms: now,
        tone_id: 0,
        vid_index: Math.max(0, input.episodeNo - 1),
      },
    ],
  });
}

function extractCommentId(data: unknown): string {
  if (typeof data !== 'object' || data === null) return '';
  const info = (data as Record<string, unknown>).comment_info;
  if (typeof info !== 'object' || info === null) return '';
  const id = (info as Record<string, unknown>).comment_id;
  return typeof id === 'string' ? id : '';
}

export interface CommentSendResult extends WriteResult {
  commentId: string;
}

/**
 * 发短剧评论（参考 SendComment → /novel/commentapi/comment/add/v1/）。
 * 参考 body：commit_source=3, data_type=4, offset=0。
 */
export async function accountSendComment(input: {
  seriesId: string;
  episodeId: string;
  text: string;
}): Promise<CommentSendResult> {
  const body = JSON.stringify({
    aid: 8662,
    business_param: {
      book_id: input.seriesId,
      has_aigc_content: false,
      ignore_urge_rule: false,
      log_extra: {},
      offset: 0,
      preset_text_id: '',
      shark_param: {
        enter_from: 'MainFragmentActivity',
        page_list: 'MainFragmentActivity',
        previous_page: '',
      },
      text_feature: {},
    },
    commit_source: 3,
    data_type: 4,
    group_id: input.episodeId,
    group_type: 30,
    text: input.text,
  });
  const result = await signedPostBody(CONTENT_HOST, '/novel/commentapi/comment/add/v1/', body);
  return { ...result, commentId: extractCommentId(result.data) };
}

/**
 * 发弹幕（参考 SendDanmaku → 同一 add 接口，data_type=20, commit_source=1500）。
 * offsetMs 是视频内时间（毫秒）。
 */
export async function accountSendDanmaku(input: {
  seriesId: string;
  episodeId: string;
  text: string;
  offsetMs: number;
}): Promise<CommentSendResult> {
  const body = JSON.stringify({
    aid: 8662,
    business_param: {
      book_id: input.seriesId,
      ignore_urge_rule: false,
      offset: Math.max(0, Math.round(input.offsetMs)),
      shark_param: {
        aid: '8662',
        enter_from: 'MainFragmentActivity',
        page_list: 'MainFragmentActivity',
        previous_page: '',
        type: 'short_play',
      },
    },
    commit_source: 1500,
    data_type: 20,
    group_id: input.episodeId,
    group_type: 30,
    text: input.text,
  });
  const result = await signedPostBody(CONTENT_HOST, '/novel/commentapi/comment/add/v1/', body);
  return { ...result, commentId: extractCommentId(result.data) };
}

/** 删除自己发的评论/弹幕（参考 DeleteComment）；实测评论 data_type=4 可删。 */
export function accountDeleteComment(input: {
  commentId: string;
  episodeId: string;
  dataType?: number;
}): Promise<WriteResult> {
  return signedPost(CONTENT_HOST, '/novel/commentapi/comment/del/v1/', {
    aid: 8662,
    comment_id: input.commentId,
    group_id: input.episodeId,
    group_type: 30,
    data_type: input.dataType ?? 4,
    comment_type: 0,
  });
}

/** 评论点赞/取消（参考 LikeComment：action_type 8=赞 9=取消）。 */
export function accountLikeComment(commentId: string, liked: boolean): Promise<WriteResult> {
  return signedPost(CONTENT_HOST, '/novel/commentapi/comment/do_action/v1/', {
    action_type: liked ? 8 : 9,
    business_param: {
      shark_param: {
        enter_from: 'MainFragmentActivity',
        page_list: 'MainFragmentActivity',
        previous_page: '',
      },
    },
    comment_type: 4,
    object_id: commentId,
    object_type: 8,
  });
}
