/** 账号资料：`/reading/user/profile/get/v?user_id=`，拿红果昵称/头像/红果号。 */
import { readDevice, readSession } from './session.ts';
import { createLogger } from '../util/log.ts';

const log = createLogger('account-profile');
const HOST = 'https://api5-normal-lq.fqnovel.com';

export interface AccountProfile {
  userId: string;
  name: string;
  avatar: string;
  hongguoId: string;
}

interface CacheEntry {
  profile: AccountProfile;
  expires: number;
}

const cache = new Map<string, CacheEntry>();
const TTL = 5 * 60_000;

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

function baseQuery(device: Device, userId: string): Record<string, string> {
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
    user_id: userId,
    version_code: '73932',
    version_name: '7.3.9.32',
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function https(url: string): string {
  return url.startsWith('http://') ? `https://${url.slice(7)}` : url;
}

/** 拿账号真实红果资料；失败返回 null，调用方回退到登录态里的昵称。 */
export async function fetchAccountProfile(userId: string): Promise<AccountProfile | null> {
  if (userId === '') return null;
  const hit = cache.get(userId);
  if (hit !== undefined && hit.expires > Date.now()) return hit.profile;

  const session = readSession();
  if (session.cookie === '') return null;
  const device = (readDevice() ?? {}) as Device;
  const path = '/reading/user/profile/get/v';

  try {
    const pairs = Object.entries(baseQuery(device, userId)).map(([k, v]) => [k, String(v)]);
    const signed = await fetch(signerUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path,
        query: pairs,
        body: '',
        deviceId: String(device.device_id ?? ''),
        version: '7.3.9.32',
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!signed.ok) return null;
    const sig = (await signed.json()) as { query?: string; headers?: Record<string, string> };

    const res = await fetch(`${HOST}${path}?${sig.query ?? ''}`, {
      method: 'GET',
      headers: {
        ...(sig.headers ?? {}),
        cookie: session.cookie,
        accept: 'application/json',
        'user-agent': String(device.user_agent ?? 'com.phoenix.read/73932'),
        ...(session.token !== '' ? { 'x-tt-token': session.token } : {}),
      },
      signal: AbortSignal.timeout(15000),
    });
    const json = (await res.json()) as {
      code?: number;
      data?: { ugc_user?: { base_info?: Record<string, unknown> } };
    };
    if (json.code !== 0) return null;
    const base = json.data?.ugc_user?.base_info ?? {};
    const name = str(base.user_name);
    if (name === '') return null;
    const profile: AccountProfile = {
      userId,
      name,
      avatar: https(
        str(base.expand_user_avatar) !== ''
          ? str(base.expand_user_avatar)
          : str(base.user_avatar),
      ),
      hongguoId: str(base.biz_user_id),
    };
    cache.set(userId, { profile, expires: Date.now() + TTL });
    return profile;
  } catch (err) {
    log.warn(`资料读取失败：${(err as Error).message}`);
    return null;
  }
}
