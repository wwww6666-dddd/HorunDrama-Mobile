/**
 * 账号能力：状态 / 会话校验 / 扫码登录（协议已实现）。
 *
 * 关于扫码：`passport/web/*` 需要「App 签名 + passport csrf」的完整握手，
 * 在部分网络下上游直接返回 error_code 16（该应用无权限）——这里如实把上游
 * 错误透出，不做静默失败。
 */
import { fetchAccountProfile } from './profile.ts';
import { clearSession, cookieCount, readDevice, readSession } from './session.ts';

const ACCOUNT_HOST = 'https://api5-normal-sinfonlinea.fqnovel.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function signerUrl(): string {
  const env = process.env.HORUN_SIGNER_URL ?? process.env.YIMU_SIGNER_URL ?? '';
  return env !== '' ? env : 'http://127.0.0.1:8791/sign';
}

export interface AccountStatus {
  loggedIn: boolean;
  userId: string;
  nickname: string;
  avatar: string;
  hongguoId: string;
  savedAt: number;
  source: string;
  cookieCount: number;
  hasDevice: boolean;
  deviceId: string;
  signerAvailable: boolean;
}

export async function accountStatus(): Promise<AccountStatus> {
  const session = readSession();
  const device = readDevice();
  let signerAvailable = false;
  try {
    const res = await fetch(signerUrl().replace('/sign', '/healthz'), { signal: AbortSignal.timeout(1200) });
    signerAvailable = res.ok;
  } catch {
    /* signer 没起 */
  }
  const status: AccountStatus = {
    loggedIn: session.cookie !== '' && session.profile.loggedIn,
    userId: session.profile.userId,
    nickname: session.profile.nickname,
    avatar: session.profile.avatar,
    hongguoId: '',
    savedAt: session.savedAt,
    source: session.source,
    cookieCount: cookieCount(session.cookie),
    hasDevice: device !== null,
    deviceId: String(device?.device_id ?? ''),
    signerAvailable,
  };
  // 登录态里的昵称是 passport 占位名，换成红果资料里的真实昵称/头像
  if (status.loggedIn) {
    const profile = await fetchAccountProfile(status.userId);
    if (profile !== null) {
      status.nickname = profile.name;
      status.avatar = profile.avatar;
      status.hongguoId = profile.hongguoId;
    }
  }
  return status;
}

/** 用「会话 + 账号设备」签名请求一个账号接口，验证登录态是否还有效。 */
export async function verifySession(): Promise<{ ok: boolean; code: number; message: string }> {
  const session = readSession();
  const device = readDevice();
  if (session.cookie === '') return { ok: false, code: -1, message: '没有登录会话' };
  if (device === null) return { ok: false, code: -2, message: '缺少账号设备身份' };

  const pairs: Array<[string, string]> = [
    ['aid', '8662'],
    ['app_name', 'novelread'],
    ['device_platform', 'android'],
    ['version_code', '690'],
    ['version_name', '6.9.0'],
    ['device_id', String(device.device_id ?? '')],
    ['install_id', String(device.install_id ?? '')],
    ['cdid', String(device.cdid ?? '')],
    ['openudid', String(device.openudid ?? '')],
    ['channel', String(device.channel ?? '')],
    ['user_is_login', '1'],
  ];
  const target = '/reading/user/subscribe/list/v1/';
  try {
    const signed = await fetch(signerUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: target,
        query: pairs,
        body: '',
        deviceId: String(device.device_id ?? ''),
        version: '6.9.0',
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!signed.ok) return { ok: false, code: -3, message: `签名服务不可用（HTTP ${signed.status}）` };
    const sig = (await signed.json()) as { query?: string; headers?: Record<string, string> };
    const res = await fetch(`${ACCOUNT_HOST}${target}?${sig.query ?? ''}`, {
      headers: {
        ...(sig.headers ?? {}),
        cookie: session.cookie,
        'user-agent': String(device.user_agent ?? UA),
        ...(session.token !== '' ? { 'x-tt-token': session.token } : {}),
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });
    const body = (await res.json().catch(() => null)) as { code?: number; message?: string } | null;
    const code = typeof body?.code === 'number' ? body.code : -4;
    return {
      ok: code === 0,
      code,
      message: code === 0 ? '会话有效' : (body?.message ?? `上游返回 code=${String(code)}`),
    };
  } catch (err) {
    return { ok: false, code: -5, message: (err as Error).message };
  }
}

/** 扫码登录：取二维码（协议已实现；上游若拒绝会原样透出错误）。 */
export async function startQrLogin(): Promise<{
  ok: boolean;
  message: string;
  qrcode?: string;
  token?: string;
  errorCode?: number;
}> {
  const host = process.env.HORUN_PASSPORT_HOST ?? 'https://hongguoduanju.com';
  const pairs = new URLSearchParams({
    aid: '8662',
    app_name: 'novelread',
    device_platform: 'web',
    need_loading: '1',
  });
  try {
    const res = await fetch(`${host}/passport/web/get_qrcode/?${pairs.toString()}`, {
      headers: { 'user-agent': UA, accept: 'application/json', referer: `${host}/` },
      signal: AbortSignal.timeout(15000),
    });
    const body = (await res.json().catch(() => null)) as
      | { data?: { qrcode?: string; token?: string; error_code?: number; description?: string }; message?: string }
      | null;
    const errorCode = body?.data?.error_code ?? -1;
    if (errorCode !== 0) {
      return {
        ok: false,
        errorCode,
        message:
          errorCode === 16
            ? '上游拒绝：该应用无权限（passport 接口对本网络封禁，error_code 16）'
            : (body?.data?.description ?? body?.message ?? `上游返回 error_code=${String(errorCode)}`),
      };
    }
    return {
      ok: true,
      message: '二维码已生成',
      qrcode: body?.data?.qrcode ?? '',
      token: body?.data?.token ?? '',
    };
  } catch (err) {
    return { ok: false, message: `请求失败：${(err as Error).message}` };
  }
}

export function logout(): void {
  clearSession();
}
