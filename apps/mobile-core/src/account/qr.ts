/**
 * 扫码登录（pc 站 passport）。
 *
 * 全部参数来自官方客户端的真实请求（GODEBUG=http2debug=2 抓包）：
 *  - GET /passport/web/get_qrcode/  aid=513755 + account_sdk_source_info（指纹 XOR 0x05 hex）
 *  - GET /passport/web/check_qrconnect/  同样的参数 + token
 *
 * 之前用 aid=8662 会得到 error_code 16「该应用无权限」——aid 才是关键。
 */
import { createLogger } from '../util/log.ts';
import { writeSession, readDevice, writeDevice, type SessionProfile } from './session.ts';

const log = createLogger('qr');

const HOST = 'https://hongguoduanju.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

interface Attempt {
  cookies: string;
  createdAt: number;
  expireAt: number;
}

const attempts = new Map<string, Attempt>();
const MAX_ATTEMPTS = 32;

/** WebView 指纹：官方客户端用 innerWidth/outerWidth 等做环境校验，XOR 0x05 后转 hex。 */
function fingerprint(): string {
  const json = JSON.stringify({
    hardwareConcurrency: 8,
    webdriver: false,
    chromedriver: false,
    shelldriver: false,
    plugins: 5,
    permissions: [{ name: 'notifications', state: 'prompt' }],
    innerHeight: 900,
    innerWidth: 1400,
    outerHeight: 900,
    outerWidth: 1400,
  });
  const bytes = Buffer.from(json, 'utf8');
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (bytes[i] ?? 0) ^ 0x05;
  return bytes.toString('hex');
}

function baseParams(): Array<[string, string]> {
  return [
    ['account_sdk_source', 'web'],
    ['account_sdk_source_info', fingerprint()],
    ['aid', '513755'],
    ['is_from_ttaccountsdk', '1'],
    ['language', 'zh'],
    ['next', 'https://hongguoduanju.com/'],
    ['p_bd', '1.0.1.20'],
    ['p_js_t', 'pro'],
    ['p_js_v', '2.4.13'],
    ['p_ver', '1.0.29'],
    ['p_zt', '3.3.5'],
    ['passport_jssdk_type', 'normal'],
    ['passport_jssdk_version', '2.4.13'],
    ['request_host', 'https://hongguoduanju.com'],
    ['ts', String(Date.now())],
  ];
}

function jarFrom(setCookies: string[]): string {
  return setCookies.map((c) => c.split(';')[0] ?? '').filter((c) => c.includes('=')).join('; ');
}

export interface QrStart {
  ok: boolean;
  message: string;
  token?: string;
  qrcode?: string;
  expireAt?: number;
  hint?: string;
}

/** 取二维码。 */
export async function startQr(): Promise<QrStart> {
  const qs = new URLSearchParams(baseParams()).toString();
  try {
    const res = await fetch(`${HOST}/passport/web/get_qrcode/?${qs}`, {
      headers: { 'user-agent': UA, accept: 'application/json', referer: `${HOST}/` },
      signal: AbortSignal.timeout(15000),
    });
    const body = (await res.json().catch(() => null)) as {
      data?: {
        error_code?: number;
        description?: string;
        qrcode?: string;
        token?: string;
        expire_time?: number;
        copywriting?: string;
        web_name?: string;
      };
    } | null;
    const data = body?.data ?? {};
    const code = data.error_code ?? -1;
    if (code !== 0) {
      return { ok: false, message: data.description ?? `上游返回 error_code=${String(code)}` };
    }
    if (typeof data.token !== 'string' || typeof data.qrcode !== 'string') {
      return { ok: false, message: '上游没有返回二维码' };
    }

    const cookies = jarFrom(res.headers.getSetCookie?.() ?? []);
    attempts.set(data.token, {
      cookies,
      createdAt: Date.now(),
      expireAt: typeof data.expire_time === 'number' ? data.expire_time * 1000 : Date.now() + 120_000,
    });
    // 控制内存：只留最近的几个
    while (attempts.size > MAX_ATTEMPTS) {
      const oldest = [...attempts.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (oldest === undefined) break;
      attempts.delete(oldest[0]);
    }

    let hint = '打开抖音 App 扫码';
    try {
      const cw = JSON.parse(data.copywriting ?? '{}') as { title?: string; desc?: string };
      hint = cw.desc?.replace(/\[color=red\]|\[\/\]/g, '') ?? hint;
    } catch {
      /* 忽略 */
    }
    return {
      ok: true,
      message: '二维码已生成',
      token: data.token,
      qrcode: data.qrcode,
      expireAt: typeof data.expire_time === 'number' ? data.expire_time * 1000 : undefined,
      hint,
    };
  } catch (err) {
    return { ok: false, message: `请求失败：${(err as Error).message}` };
  }
}

export interface QrPoll {
  status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error';
  message: string;
  profile?: SessionProfile;
}

/** 轮询扫码结果；确认后落会话 Cookie。 */
export async function pollQr(token: string): Promise<QrPoll> {
  const attempt = attempts.get(token);
  if (attempt === undefined) return { status: 'expired', message: '二维码已失效，请刷新' };
  if (Date.now() > attempt.expireAt) {
    attempts.delete(token);
    return { status: 'expired', message: '二维码已过期，请刷新' };
  }

  const params: Array<[string, string]> = [...baseParams(), ['token', token]];
  const qs = new URLSearchParams(params).toString();
  try {
    const res = await fetch(`${HOST}/passport/web/check_qrconnect/?${qs}`, {
      headers: {
        'user-agent': UA,
        accept: 'application/json',
        referer: `${HOST}/`,
        cookie: attempt.cookies,
      },
      signal: AbortSignal.timeout(12000),
    });
    const setCookies = res.headers.getSetCookie?.() ?? [];
    const body = (await res.json().catch(() => null)) as {
      data?: { error_code?: number; description?: string; status?: number; user_id?: string; nick_name?: string };
      message?: string;
    } | null;
    const data = body?.data ?? {};
    const code = data.error_code ?? -1;

    // 会话 Cookie 出现即视为确认成功（sessionid / sid_tt / uid_tt）
    const jar = jarFrom(setCookies);
    const hasSession = /(^|;\s*)(sessionid|sessionid_ss|sid_tt|uid_tt|uid_tt_ss)=/.test(jar);
    if (hasSession) {
      if (readDevice() === null) {
        writeDevice({ device_id: String(Date.now()).slice(-16), user_agent: UA, channel: 'hongguo' });
      }
      const profile: SessionProfile = {
        userId: String(data.user_id ?? ''),
        nickname: String(data.nick_name ?? ''),
        avatar: '',
        loggedIn: true,
      };
      writeSession({ cookie: jar, token: '', profile, source: 'qrcode' });
      attempts.delete(token);
      log.info(`扫码登录成功：Cookie ${jar.split(';').length} 条`);
      return { status: 'confirmed', message: '登录成功', profile };
    }

    if (code === 0) return { status: 'waiting', message: '等待扫码…' };
    if (code === 1 || data.status === 1) return { status: 'scanned', message: '已扫码，请在手机上确认' };
    if (code === 2 || data.status === 2) return { status: 'confirmed', message: '已确认' };
    return { status: 'waiting', message: data.description ?? body?.message ?? `error_code=${String(code)}` };
  } catch (err) {
    return { status: 'error', message: (err as Error).message };
  }
}
