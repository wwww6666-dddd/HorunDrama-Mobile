/**
 * 手机号 + 验证码登录（完全复刻官方客户端  的真实请求）。
 *
 * 这些参数是用 GODEBUG=http2debug=2 抓到官方客户端请求行、再从进程内存里读出完整
 * POST body 后逐项确认的（2026-11-16），别再凭猜改：
 *
 *  - 主机：api5-normal-lq.fqnovel.com
 *  - 发码：POST /passport/mobile/send_code/v1/
 *  - 登录：POST /passport/mobile/sms_login/
 *  - **所有参数都放在 form body 里**（不是 query），按字典序排序
 *  - mobile 要 XOR(0x05) 后转 hex，并且带国家码：`+8617737190381`
 *  - code 同样 XOR(0x05) hex（明文验证码会被判 3052）
 *  - 发码必须带 `type=3731`（XOR 解码即 24，短信登录场景）与 `unbind_exist=34`；
 *    只带 `type=1` 时上游会当成「绑定手机号」，对已绑定号码回 1001 换绑
 *  - 额外头：`x-ss-stub` = body 的 MD5（大写）；passport 接口**不需要签名头**
 *  - 游客 Cookie（install_id / ttreq / store-region）能进一步降低风控
 *
 * 登录成功后从响应头取 `x-tt-token`，再用 `/passport/account/info/v2/` 拿资料。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from '../config.ts';
import { createLogger } from '../util/log.ts';
import { getClient } from '../sources/client.ts';
import { writeDevice, writeSession, type DeviceIdentity, type SessionProfile } from './session.ts';
import { syncAccountData } from './data.ts';

const log = createLogger('sms');

const PASSPORT_HOST = process.env.HORUN_PASSPORT_API ?? 'https://api5-normal-lq.fqnovel.com';
const UA =
  'com.phoenix.read/73932 (Linux; U; Android 14; zh_CN; Xiaomi 14; Build/UKQ1.230804.001; ' +
  'Cronet/TTNetVersion:8d40f833 QuicVersion:462f352c 2026-08-31)';

/** 发码场景：官方客户端实际发送 type=3731（XOR(0x05) 解码为 "24"）。 */
const SEND_CODE_TYPE = '3731';
/** 官方客户端发码时同发的解绑标记（实测原样 34）。 */
const SEND_CODE_UNBIND = '34';

interface AppDeviceFile {
  device_id_str?: string;
  install_id_str?: string;
  cdid?: string;
  openudid?: string;
  ttreq?: string;
  store_region?: string;
  created_at?: string;
  device?: {
    brand?: string;
    model?: string;
    os_version?: string;
    os_api?: number | string;
    resolution?: string;
    dpi?: number | string;
    channel?: string;
  };
}

function readAppDeviceFile(): AppDeviceFile | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'app-device.json'), 'utf8')) as AppDeviceFile;
  } catch {
    return null;
  }
}

/**
 * 登录用的设备身份：与浏览共用同一台匿名设备（官方客户端也是这么做的）。
 * 没有匿名设备时让 SDK 现场注册一台，保证 device_id / iid / cdid 都真实存在。
 */
async function ensureAppDevice(): Promise<{
  deviceId: string;
  installId: string;
  cdid: string;
  openudid: string;
  ttreq: string;
  storeRegion: string;
  brand: string;
  model: string;
  osVersion: string;
  osApi: string;
  resolution: string;
  dpi: string;
  channel: string;
}> {
  let raw = readAppDeviceFile();
  if (raw === null || String(raw.device_id_str ?? '') === '' || String(raw.install_id_str ?? '') === '') {
    log.info('没有匿名设备档案，先让 SDK 注册一台');
    const client = await getClient();
    await client.resetDevice();
    raw = readAppDeviceFile();
  }
  if (raw === null) throw new Error('无法准备匿名设备（app-device.json 缺失）');
  return {
    deviceId: String(raw.device_id_str ?? ''),
    installId: String(raw.install_id_str ?? ''),
    cdid: String(raw.cdid ?? ''),
    openudid: String(raw.openudid ?? ''),
    ttreq: String(raw.ttreq ?? ''),
    storeRegion: String(raw.store_region ?? 'cn-ha'),
    brand: String(raw.device?.brand ?? 'xiaomi').toLowerCase(),
    model: String(raw.device?.model ?? '23127PN0CC'),
    osVersion: String(raw.device?.os_version ?? '14'),
    osApi: String(raw.device?.os_api ?? '34'),
    resolution: String(raw.device?.resolution ?? '1200*2670'),
    dpi: String(raw.device?.dpi ?? '460'),
    channel: String(raw.device?.channel ?? 'xiaomi_8662_64'),
  };
}

type LoginDevice = Awaited<ReturnType<typeof ensureAppDevice>>;

const PENDING_FILE = path.join(DATA_ROOT, 'sms-pending.json');

interface PendingSms {
  mobile: string;
  cookie: string;
  mobileTicket: string;
  device: DeviceIdentity;
  mfa?: MfaContext;
  at: number;
}

function readPending(mobile: string): PendingSms | null {
  try {
    const raw = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')) as PendingSms;
    if (raw.mobile !== mobile) return null;
    // 验证码 10 分钟内有效；过期就不用旧 Cookie
    if (Date.now() - raw.at > 10 * 60_000) return null;
    return raw;
  } catch {
    return null;
  }
}

function writePending(next: PendingSms): void {
  try {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(PENDING_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch (err) {
    log.warn(`写入发码上下文失败：${(err as Error).message}`);
  }
}

function clearPending(): void {
  try {
    fs.rmSync(PENDING_FILE, { force: true });
  } catch {
    /* 忽略 */
  }
}

/** 把 Set-Cookie 合并进现有 cookie 串（同名覆盖）。 */
function mergeCookies(existing: string, headers: string[]): string {
  const map = new Map<string, string>();
  for (const part of existing.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  for (const header of headers) {
    const first = header.split(';')[0] ?? '';
    const i = first.indexOf('=');
    if (i > 0) map.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join('; ');
}

function xorHex(value: string): string {
  return [...new TextEncoder().encode(value)]
    .map((b) => (b ^ 0x05).toString(16).padStart(2, '0'))
    .join('');
}

function normalizeMobile(mobile: string): string {
  const digits = mobile.replace(/\D/g, '');
  if (digits.length === 11) return `+86${digits}`;
  if (digits.length === 13 && digits.startsWith('86')) return `+${digits}`;
  return `+${digits}`;
}

/** 官方客户端请求体的完整参数集（按 key 排序，值全部是字符串）。 */
function buildParams(device: LoginDevice, extra: Record<string, string>): URLSearchParams {
  const now = Date.now();
  const params: Record<string, string> = {
    _rticket: String(now),
    ac: 'wifi',
    account_sdk_source: 'app',
    aid: '8662',
    app_dark_mode: '0',
    app_mini_window: '0',
    app_name: 'novelread',
    auto_read: '0',
    battery_pct: '98',
    cdid: device.cdid,
    channel: device.channel,
    charging: '1',
    cold_start_session_cnt_in_day: '1',
    cold_start_session_cnt_in_life: '1',
    cold_start_session_id: crypto.randomUUID(),
    compliance_status: '0',
    current_volume: '1',
    device_brand: device.brand,
    device_id: device.deviceId,
    device_platform: 'android',
    device_type: device.model,
    down_speed: '558813',
    dpi: device.dpi,
    dragon_device_type: 'phone',
    font_scale: '100',
    gender: '2',
    har_status: '0',
    host_abi: 'arm64-v8a',
    iid: device.installId,
    is_android_pad_screen: '0',
    is_power_save_mode: '0',
    language: 'zh',
    manifest_version_code: '73932',
    mix_mode: '1',
    need_personal_recommend: '1',
    network_type: '4',
    normal_session_cnt_in_day: '1',
    normal_session_cnt_in_life: '1',
    normal_session_id: `${crypto.randomUUID()}%2523265`,
    os: 'android',
    os_api: device.osApi,
    os_version: device.osVersion,
    passport_support_flow: 'captcha%2Cverify',
    player_so_load: '1',
    pv_player: '73932',
    resolution: device.resolution,
    rom_version: 'miui_V12_V12.0.8.0.RKHCNXM',
    screen_brightness: '436',
    ssmix: 'a',
    sys_dark_mode: '0',
    sys_mini_window: '1',
    update_version_code: '73932',
    version_code: '73932',
    version_name: '7.3.9.32',
    ...extra,
  };
  return new URLSearchParams(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function guestCookie(device: LoginDevice): string {
  return [
    'passport_csrf_token=',
    'passport_csrf_token_default=',
    `store-region=${device.storeRegion}`,
    'store-region-src=did',
    `install_id=${device.installId}`,
    `ttreq=${device.ttreq}`,
  ].join('; ');
}

interface PassportReply {
  status: number;
  json: Record<string, unknown> | null;
  cookies: string[];
  token: string;
  headers: Record<string, string>;
  raw: string;
}

async function postPassport(target: string, body: URLSearchParams, cookie: string): Promise<PassportReply> {
  const md5 = crypto.createHash('md5').update(body.toString()).digest('hex').toUpperCase();
  const res = await fetch(`${PASSPORT_HOST}${target}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': UA,
      'passport-sdk-version': '5051452',
      accept: 'application/json',
      'x-ss-stub': md5,
      cookie,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(20000),
  });
  const raw = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    json = null;
  }
  if (res.status !== 200) log.warn(`HTTP ${res.status} ${target} ${raw.slice(0, 200)}`);
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return {
    status: res.status,
    json,
    cookies: res.headers.getSetCookie?.() ?? [],
    token: res.headers.get('x-tt-token') ?? '',
    headers,
    raw,
  };
}

function dataOf(json: Record<string, unknown> | null): Record<string, unknown> {
  const data = json?.data;
  return data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {};
}

/** 发验证码。 */
export async function sendSmsCode(
  mobile: string,
): Promise<{ ok: boolean; code: number; message: string; smsCodeKey?: string; retryAfter?: number }> {
  if (!/^1\d{10}$/.test(mobile)) return { ok: false, code: -1, message: '手机号格式不对' };

  try {
    // 如果当前已经在「上行短信验证（MFA）」流程里，重新发码时保留原 MFA 上下文、
    // 设备和 passport_mfa_token；否则新码会换掉上下文，上游直接 1203。
    const previous = readPending(mobile);
    const keepMfa = previous !== null && previous.mfa !== undefined;
    const device = keepMfa && previous !== null ? deviceFromIdentity(previous.device) : await ensureAppDevice();
    // 会话与设备必须成对：登录用哪台设备，就把这台记成账号设备
    writeDevice(toDeviceIdentity(device));
    const body = buildParams(device, {
      mobile: xorHex(normalizeMobile(mobile)),
      type: SEND_CODE_TYPE,
      unbind_exist: SEND_CODE_UNBIND,
    });
    const reply = await postPassport('/passport/mobile/send_code/v1/', body, previous?.cookie ?? guestCookie(device));
    log.info(`send_code：HTTP ${reply.status} ${reply.raw.slice(0, 240)}`);

    const data = dataOf(reply.json);
    if (reply.json?.message === 'success') {
      const retry = Number(data.retry_time ?? 60);
      // 上游会给发码请求下发 passport_csrf_token 等 Cookie；登录时必须带上同一份，
      // 否则验证码会被判「过期/错误次数过多」（实测 1203）。
      writePending({
        mobile,
        cookie: mergeCookies(previous?.cookie ?? guestCookie(device), reply.cookies),
        mobileTicket: keepMfa ? previous?.mobileTicket ?? String(data.mobile_ticket ?? '') : String(data.mobile_ticket ?? ''),
        device: keepMfa ? previous?.device ?? toDeviceIdentity(device) : toDeviceIdentity(device),
        mfa: keepMfa ? previous?.mfa : undefined,
        at: Date.now(),
      });
      return {
        ok: true,
        code: 0,
        message: `验证码已发送至 ${String(data.mobile ?? mobile)}`,
        smsCodeKey: String(data.mobile_ticket ?? ''),
        retryAfter: Number.isFinite(retry) ? retry : 60,
      };
    }
    const errCode = Number(data.error_code ?? -2);
    const description = String(data.description ?? reply.json?.message ?? '未知错误');
    log.warn(`发码失败 code=${errCode} ${description}`);
    return { ok: false, code: errCode, message: describe(errCode, description) };
  } catch (err) {
    return { ok: false, code: -3, message: (err as Error).message };
  }
}

/** 验证码登录；成功后写会话 + 账号设备 + 资料。 */
export async function loginWithSms(
  mobile: string,
  code: string,
  _smsCodeKey = '',
): Promise<{ ok: boolean; code: number; message: string; profile?: SessionProfile; needsNewCode?: boolean }> {
  if (!/^1\d{10}$/.test(mobile)) return { ok: false, code: -1, message: '手机号格式不对' };
  if (!/^\d{4,8}$/.test(code)) return { ok: false, code: -1, message: '验证码格式不对' };

  try {
    const pending = readPending(mobile);
    const device = pending !== null ? deviceFromIdentity(pending.device) : await ensureAppDevice();
    writeDevice(toDeviceIdentity(device));
    const body = applyMfaParams(
      buildParams(device, {
        mobile: xorHex(normalizeMobile(mobile)),
        code: xorHex(code),
      }),
      pending?.mfa,
    );
    const requestCookie = pending !== null ? pending.cookie : guestCookie(device);
    let reply = await postPassport('/passport/mobile/sms_login/', body, requestCookie);
    log.info(`sms_login：HTTP ${reply.status} ${reply.raw.slice(0, 240)}`);
    try {
      fs.writeFileSync(path.join(DATA_ROOT, 'last-sms-reply.json'), reply.raw, 'utf8');
      fs.writeFileSync(
        path.join(DATA_ROOT, 'last-sms-headers.json'),
        JSON.stringify({ headers: reply.headers, cookies: reply.cookies }, null, 2),
        'utf8',
      );
    } catch {
      /* 调试用，写不进去不影响 */
    }

    const data = dataOf(reply.json);
    let success = reply.json?.message === 'success' || Number(data.error_code ?? -1) === 0;
    const pendingCookie = pending !== null ? pending.cookie : guestCookie(device);
    let usedCookie = pendingCookie;

    if (!success) {
      const errCode = Number(data.error_code ?? -2);
      const description = String(data.description ?? reply.json?.message ?? '未知错误');
      // 2046：把 MFA 上下文和 passport_mfa_token 存下来，再走上行短信验证
      if (errCode === 2046) {
        const mfa = mfaContextOf(data);
        usedCookie = mergeCookies(pendingCookie, reply.cookies);
        writePending({
          mobile,
          cookie: usedCookie,
          mobileTicket: pending?.mobileTicket ?? String(data.mobile_ticket ?? ''),
          device: pending?.device ?? toDeviceIdentity(device),
          mfa,
          at: Date.now(),
        });

        const verified = await upsmsVerify(device, usedCookie, mfa);
        if (verified.ok) {
          const verifyCookie = mergeCookies(usedCookie, verified.cookies);
          mfa.ticket = verified.ticket;
          writePending({
            mobile,
            cookie: verifyCookie,
            mobileTicket: pending?.mobileTicket ?? String(data.mobile_ticket ?? ''),
            device: pending?.device ?? toDeviceIdentity(device),
            mfa,
            at: Date.now(),
          });
          const retryBody = applyMfaParams(new URLSearchParams(body), mfa);
          const retry = await postPassport('/passport/mobile/sms_login/', retryBody, verifyCookie);
          const retryData = dataOf(retry.json);
          const retryOk = retry.json?.message === 'success' || Number(retryData.error_code ?? -1) === 0;
          log.info(`MFA 通过后重试登录：HTTP ${retry.status} ${retry.raw.slice(0, 160)}`);
          if (retryOk) {
            reply = retry;
            usedCookie = verifyCookie;
            success = true;
          } else {
            const retryCode = Number(retryData.error_code ?? -2);
            return {
              ok: false,
              code: retryCode,
              message: describe(retryCode, String(retryData.description ?? '')),
            };
          }
        } else {
          const upSms = mfa.upSms;
          const hint =
            upSms === null
              ? '上游要求身份验证（MFA），暂无法自动完成'
              : `上游要求身份验证：请用手机向 ${upSms.channelMobile} 发送短信 ${upSms.smsContent}。` +
                '发送完成后点「我已发送，继续验证」。**不要重新获取验证码**——重新获取会换掉 MFA 上下文，' +
                '上游会判 1203「验证码已过期或长时间未操作」。';
          log.warn(`需要上行短信验证：${hint}`);
          return { ok: false, code: errCode, message: hint };
        }
      }
      if (!success) {
        if (reply.cookies.length > 0) {
          const kept = readPending(mobile);
          writePending({
            mobile,
            cookie: mergeCookies(kept?.cookie ?? pendingCookie, reply.cookies),
            mobileTicket: kept?.mobileTicket ?? String(data.mobile_ticket ?? ''),
            device: kept?.device ?? toDeviceIdentity(device),
            at: Date.now(),
          });
        }
        return { ok: false, code: errCode, message: describe(errCode, description) };
      }
    }

    const pairs = reply.cookies.map((c) => c.split(';')[0] ?? '').filter((c) => c.includes('='));
    const cookie = mergeCookies(usedCookie, pairs);
    if (pairs.length === 0) return { ok: false, code: -4, message: '登录成功但上游没有下发 Cookie' };

    const token = reply.token;
    const profile = await fetchProfile(cookie, token, device, mobile);
    writeSession({ cookie, token, profile, source: 'sms' });
    clearPending();
    // 登录后把账号的收藏/历史/预约拉下来，否则页面只有本机数据
    void syncAccountData(true).catch(() => undefined);
    log.info(`手机号登录成功：Cookie ${pairs.length} 条，userId=${profile.userId}，昵称=${profile.nickname}`);
    return { ok: true, code: 0, message: `登录成功：${profile.nickname || profile.userId}`, profile };
  } catch (err) {
    return { ok: false, code: -3, message: (err as Error).message };
  }
}

function toDeviceIdentity(device: LoginDevice): DeviceIdentity {
  return {
    device_id: device.deviceId,
    install_id: device.installId,
    iid: device.installId,
    cdid: device.cdid,
    openudid: device.openudid,
    channel: device.channel,
    ttreq: device.ttreq,
    store_region: device.storeRegion,
    device_brand: device.brand,
    device_type: device.model,
    os_version: device.osVersion,
    os_api: device.osApi,
    resolution: device.resolution,
    dpi: device.dpi,
    user_agent: UA,
  };
}

/** 登录时优先沿用「发码那一刻」的设备，避免两次请求设备不一致导致验证码对不上。 */
function deviceFromIdentity(d: DeviceIdentity): LoginDevice {
  return {
    deviceId: String(d.device_id ?? ''),
    installId: String(d.install_id ?? d.iid ?? ''),
    cdid: String(d.cdid ?? ''),
    openudid: String(d.openudid ?? ''),
    ttreq: String(d.ttreq ?? ''),
    storeRegion: String(d.store_region ?? 'cn-ha'),
    brand: String(d.device_brand ?? 'xiaomi').toLowerCase(),
    model: String(d.device_type ?? '23127PN0CC'),
    osVersion: String(d.os_version ?? '14'),
    osApi: String(d.os_api ?? '34'),
    resolution: String(d.resolution ?? '1200*2670'),
    dpi: String(d.dpi ?? '460'),
    channel: String(d.channel ?? 'xiaomi_8662_64'),
  };
}

/** 用会话拉账号资料；失败也不影响登录本身。 */
async function fetchProfile(
  cookie: string,
  token: string,
  device: LoginDevice,
  mobile: string,
): Promise<SessionProfile> {
  const now = Date.now();
  const query = new URLSearchParams({
    _rticket: String(now),
    ac: 'wifi',
    aid: '8662',
    app_name: 'novelread',
    cdid: device.cdid,
    channel: device.channel,
    compliance_status: '0',
    device_brand: device.brand,
    device_id: device.deviceId,
    device_platform: 'android',
    device_type: device.model,
    dpi: device.dpi,
    dragon_device_type: 'phone',
    host_abi: 'arm64-v8a',
    iid: device.installId,
    is_android_pad_screen: '0',
    language: 'zh',
    manifest_version_code: '73932',
    os: 'android',
    os_api: device.osApi,
    os_version: device.osVersion,
    'passport-sdk-version': '5051452',
    resolution: device.resolution,
    ssmix: 'a',
    ts: String(Math.floor(now / 1000)),
    update_version_code: '73932',
    use_store_region_cookie: '1',
    version_code: '73932',
    version_name: '7.3.9.32',
  });
  const fallback: SessionProfile = { userId: '', nickname: '', avatar: '', loggedIn: true };
  try {
    const res = await fetch(`${PASSPORT_HOST}/passport/account/info/v2/?${query.toString()}`, {
      headers: {
        accept: 'application/json',
        cookie,
        'user-agent': UA,
        ...(token !== '' ? { 'x-tt-token': token } : {}),
      },
      signal: AbortSignal.timeout(12000),
    });
    const json = (await res.json().catch(() => null)) as { data?: Record<string, unknown> } | null;
    const data = json?.data ?? {};
    const profile: SessionProfile = {
      userId: String(data.user_id_str ?? data.user_id ?? ''),
      nickname: String(data.screen_name ?? data.name ?? ''),
      avatar: String(data.avatar_url ?? ''),
      loggedIn: true,
    };
    log.info(`账号资料：${profile.nickname} / ${profile.userId} / ${String(data.mobile ?? mobile)}`);
    return profile;
  } catch (err) {
    log.warn(`拉取账号资料失败：${(err as Error).message}`);
    return fallback;
  }
}

interface MfaContext {
  biz: Record<string, string>;
  encryptUid: string;
  logId: string;
  verifyScene: string;
  verifyReason: string;
  copywritingKey: string;
  diversionTag: string;
  upSms: { channelMobile: string; smsContent: string } | null;
  /** upsms/verify 成功返回的 ticket；重试 sms_login 时必须带上 */
  ticket?: string;
}

/** 从 2046 响应里抽出上行短信验证需要的全部上下文（官方客户端 upsms/verify 的入参）。 */
function mfaContextOf(data: Record<string, unknown>): MfaContext {
  const obj = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const biz = obj(data.biz_params);
  const common = obj(data.common_params);
  const event = obj(data.event_params);
  const ways = Array.isArray(data.verify_ways) ? (data.verify_ways as Array<Record<string, unknown>>) : [];
  const up = ways.find((way) => way.verify_way === 'mobile_up_sms_verify');
  return {
    biz: {
      passport_mfa_retry_tag: String(biz.passport_mfa_retry_tag ?? ''),
      sms_code_key: String(biz.sms_code_key ?? ''),
    },
    encryptUid: String(data.encrypt_uid ?? ''),
    logId: String(event.log_id ?? ''),
    verifyScene: String(event.verify_scene ?? 'sms_login'),
    verifyReason: String(event.verify_reason ?? 'ato'),
    copywritingKey: String(common.copywriting_key ?? 'sms_login'),
    diversionTag: String(common.ies_safety_diversion_tag ?? 'mfa'),
    upSms:
      up === undefined
        ? null
        : { channelMobile: String(up.channel_mobile ?? ''), smsContent: String(up.sms_content ?? '') },
    ticket: '',
  };
}

/** upsms/verify 的设备参数走 query（官方客户端实测）。 */
function upsmsQuery(device: LoginDevice): string {
  const now = Date.now();
  return new URLSearchParams({
    _rticket: String(now),
    ac: 'wifi',
    aid: '8662',
    app_name: 'novelread',
    cdid: device.cdid,
    channel: device.channel,
    compliance_status: '0',
    cronet_version: '8d40f833_2026-03-03',
    device_brand: device.brand,
    device_id: device.deviceId,
    device_platform: 'android',
    device_type: device.model,
    dpi: device.dpi,
    dragon_device_type: 'phone',
    host_abi: 'arm64-v8a',
    iid: device.installId,
    is_android_pad_screen: '0',
    language: 'zh',
    manifest_version_code: '73932',
    need_personal_recommend: '1',
    os: 'android',
    os_api: device.osApi,
    os_version: device.osVersion,
    'passport-sdk-version': '5051452',
    player_so_load: '1',
    pv_player: '73932',
    resolution: device.resolution,
    ssmix: 'a',
    ttnet_version: '4.2.243.31-douyin',
    update_version_code: '73932',
    use_new_token_expire_rule: 'true',
    use_store_region_cookie: '1',
    version_code: '73932',
    version_name: '7.3.9.32',
  }).toString();
}

/**
 * 上行短信验证（官方客户端在 2046 之后立刻调用）。
 * body 参数与顺序都照抄实测抓包：biz_params 是 JSON 字符串，verify_ticket 传空串。
 */
async function upsmsVerify(
  device: LoginDevice,
  cookie: string,
  mfa: MfaContext,
): Promise<{ ok: boolean; cookies: string[]; message: string; ticket: string }> {
  const body = new URLSearchParams({
    biz_params: JSON.stringify(mfa.biz),
    copywriting_key: mfa.copywritingKey,
    encrypt_uid: mfa.encryptUid,
    ies_safety_diversion_tag: mfa.diversionTag,
    new_authn_sdk_log_id: mfa.logId,
    new_authn_sdk_verify_reason: mfa.verifyReason,
    new_authn_sdk_verify_scene: mfa.verifyScene,
    new_authn_sdk_version: '1.1.31',
    new_verify_flow: '',
    request_tag_from: 'h5',
    verify_reason: mfa.verifyReason,
    verify_scene: mfa.verifyScene,
    verify_ticket: '',
  });
  try {
    const res = await fetch(`${PASSPORT_HOST}/passport/upsms/verify/?${upsmsQuery(device)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': UA,
        'passport-sdk-version': '5051452',
        accept: 'application/json',
        'x-ss-stub': crypto.createHash('md5').update(body.toString()).digest('hex').toUpperCase(),
        cookie,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(20000),
    });
    const raw = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      json = null;
    }
    const data = dataOf(json);
    const ok = (json?.message === 'success' || Number(data.error_code ?? -1) === 0) && res.status === 200;
    const message = String(data.description ?? json?.message ?? `HTTP ${res.status}`);
    log.info(`upsms/verify：HTTP ${res.status} ok=${String(ok)} ${raw.slice(0, 200)}`);
    return {
      ok,
      cookies: res.headers.getSetCookie?.() ?? [],
      message,
      ticket: String(data.ticket ?? ''),
    };
  } catch (err) {
    log.warn(`upsms/verify 失败：${(err as Error).message}`);
    return { ok: false, cookies: [], message: (err as Error).message, ticket: '' };
  }
}

/**
 * 上行短信「我已发送」之后继续：只重跑 upsms/verify + 重试 sms_login，
 * 不重新发码，也不换 MFA 上下文（换了频道号码就白发了）。
 */
export async function continueSmsLogin(
  mobile: string,
  code: string,
): Promise<{ ok: boolean; code: number; message: string; profile?: SessionProfile }> {
  if (!/^1\d{10}$/.test(mobile)) return { ok: false, code: -1, message: '手机号格式不对' };
  if (!/^\d{4,8}$/.test(code)) return { ok: false, code: -1, message: '验证码格式不对' };
  const pending = readPending(mobile);
  if (pending === null || pending.mfa === undefined) {
    return { ok: false, code: -1, message: '没有待验证的登录，请重新获取验证码' };
  }
  try {
    const device = deviceFromIdentity(pending.device);
    const verified = await upsmsVerify(device, pending.cookie, pending.mfa);
    if (!verified.ok) {
      const to = pending.mfa.upSms?.channelMobile ?? '';
      const content = pending.mfa.upSms?.smsContent ?? '';
      return {
        ok: false,
        code: 2046,
        message: `还没收到上行短信，请确认已用手机向 ${to} 发送 ${content}，稍等几秒再试`,
      };
    }
    const cookie = mergeCookies(pending.cookie, verified.cookies);
    pending.mfa.ticket = verified.ticket;
    writePending({ ...pending, cookie, at: Date.now() });
    const body = applyMfaParams(
      buildParams(device, { mobile: xorHex(normalizeMobile(mobile)), code: xorHex(code) }),
      pending.mfa,
    );
    const reply = await postPassport('/passport/mobile/sms_login/', body, cookie);
    const data = dataOf(reply.json);
    if (!(reply.json?.message === 'success' || Number(data.error_code ?? -1) === 0)) {
      const errCode = Number(data.error_code ?? -2);
      return { ok: false, code: errCode, message: describe(errCode, String(data.description ?? '')) };
    }
    const pairs = reply.cookies.map((c) => c.split(';')[0] ?? '').filter((c) => c.includes('='));
    if (pairs.length === 0) return { ok: false, code: -4, message: '登录成功但上游没有下发 Cookie' };
    const finalCookie = mergeCookies(cookie, pairs);
    const profile = await fetchProfile(finalCookie, reply.token, device, mobile);
    writeSession({ cookie: finalCookie, token: reply.token, profile, source: 'sms' });
    clearPending();
    void syncAccountData(true).catch(() => undefined);
    log.info(`上行短信验证后登录成功：userId=${profile.userId} 昵称=${profile.nickname}`);
    return { ok: true, code: 0, message: `登录成功：${profile.nickname || profile.userId}`, profile };
  } catch (err) {
    return { ok: false, code: -3, message: (err as Error).message };
  }
}

/** MFA 通过后重试登录时，把 upsms 下发的 ticket 与 tag/key 一起带上（官方客户端 1303 字节的 body 就是多了这些）。 */
function applyMfaParams(body: URLSearchParams, mfa: MfaContext | undefined): URLSearchParams {
  if (mfa === undefined || String(mfa.ticket ?? '') === '') return body;
  body.set('verify_ticket', String(mfa.ticket));
  body.set('passport_mfa_retry_tag', mfa.biz.passport_mfa_retry_tag ?? '');
  body.set('sms_code_key', mfa.biz.sms_code_key ?? '');
  return body;
}

function describe(code: number, description: string): string {
  if (code === 7) return '访问太频繁，请等 5~10 分钟再试';
  if (code === 1001) return description;
  if (code === 1003) return description || '手机号格式不对';
  if (code === 1017) return '验证码不能为空';
  if (code === 1202) return '验证码错误，请重新输入';
  if (code === 1203) return '验证码错误次数过多或已过期，请重新获取';
  if (code === 100107) return 'network err：会话与设备不匹配';
  if (/人机验证|captcha/i.test(description)) return '上游要求人机验证，请稍后再试';
  return description;
}
