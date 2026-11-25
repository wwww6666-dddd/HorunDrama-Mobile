/**
 * 账号会话与设备身份（本地文件，0600）。
 *
 * 与「匿名浏览设备」严格分开：
 *  - app-device.json      匿名设备（openhongguo SDK 注册，用于目录/播放）
 *  - session-device.json  账号设备（登录签发会话的那台设备，用于账号接口签名）
 *  - session.json         cookie / uid / token / profile
 *
 * 为什么分开：账号接口校验的是「会话 + 签发该会话的设备」这一对，
 * 用错设备会得到 100107 network err。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DATA_ROOT } from '../config.ts';
import { createLogger } from '../util/log.ts';

const require = createRequire(import.meta.url);
const { parseSessionFile, serializeSessionFile } = require('./session-vault.cjs') as {
  parseSessionFile: (contents: string, key: string) => { value: Partial<Session>; encrypted: boolean };
  serializeSessionFile: (value: Session, key: string) => string;
};

const log = createLogger('account');

const SESSION_FILE = path.join(DATA_ROOT, 'session.json');
const DEVICE_FILE = path.join(DATA_ROOT, 'session-device.json');
const SESSION_KEY = process.env.HORUN_SESSION_KEY ?? '';

export interface SessionProfile {
  userId: string;
  nickname: string;
  avatar: string;
  loggedIn: boolean;
}

export interface Session {
  cookie: string;
  token: string;
  profile: SessionProfile;
  savedAt: number;
  source: 'import' | 'qrcode' | 'manual' | 'sms';
}

export interface DeviceIdentity {
  device_id?: string;
  install_id?: string;
  cdid?: string;
  openudid?: string;
  channel?: string;
  user_agent?: string;
  odin_tt?: string;
  device_token?: string;
  ttreq?: string;
  store_region?: string;
  [k: string]: unknown;
}

const EMPTY_PROFILE: SessionProfile = { userId: '', nickname: '', avatar: '', loggedIn: false };

let sessionCache: Session | null = null;
let sessionMtime = -1;
let deviceCache: DeviceIdentity | null = null;
let deviceMtime = -1;

export function readSession(): Session {
  let mtime = -1;
  try {
    mtime = fs.statSync(SESSION_FILE).mtimeMs;
  } catch {
    mtime = -1;
  }
  if (mtime === -1) {
    sessionCache = null;
    return { cookie: '', token: '', profile: EMPTY_PROFILE, savedAt: 0, source: 'manual' };
  }
  if (sessionCache !== null && mtime === sessionMtime) return sessionCache;
  try {
    const { value: raw, encrypted } = parseSessionFile(fs.readFileSync(SESSION_FILE, 'utf8'), SESSION_KEY);
    sessionCache = {
      cookie: typeof raw.cookie === 'string' ? raw.cookie : '',
      token: typeof raw.token === 'string' ? raw.token : '',
      profile: { ...EMPTY_PROFILE, ...(raw.profile ?? {}) },
      savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : 0,
      source:
        raw.source === 'qrcode' || raw.source === 'import' || raw.source === 'sms' || raw.source === 'manual'
          ? raw.source
          : 'manual',
    };
    if (!encrypted && SESSION_KEY !== '') {
      fs.writeFileSync(SESSION_FILE, serializeSessionFile(sessionCache, SESSION_KEY), { mode: 0o600 });
      sessionMtime = fs.statSync(SESSION_FILE).mtimeMs;
    } else {
      sessionMtime = mtime;
    }
  } catch (err) {
    log.warn(`session.json 解析失败: ${(err as Error).message}`);
    sessionCache = null;
    return { cookie: '', token: '', profile: EMPTY_PROFILE, savedAt: 0, source: 'manual' };
  }
  return sessionCache;
}

export function writeSession(next: {
  cookie: string;
  token?: string;
  profile?: Partial<SessionProfile>;
  source: Session['source'];
}): Session {
  const prev = readSession();
  const value: Session = {
    // 合并而不是整串替换：store-region / csrf 这类持久项不能被覆盖掉
    cookie: mergeCookie(prev.cookie, next.cookie),
    token: next.token !== undefined && next.token !== '' ? next.token : prev.token,
    profile: { ...prev.profile, ...(next.profile ?? {}) },
    savedAt: Date.now(),
    source: next.source,
  };
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  fs.writeFileSync(SESSION_FILE, serializeSessionFile(value, SESSION_KEY), { mode: 0o600 });
  sessionCache = value;
  sessionMtime = fs.statSync(SESSION_FILE).mtimeMs;
  return value;
}

export function clearSession(): void {
  try {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  } catch (err) {
    log.warn(`删除 session.json 失败：${(err as Error).message}`);
  }
  sessionCache = null;
  sessionMtime = -1;
}

export function readDevice(): DeviceIdentity | null {
  let mtime = -1;
  try {
    mtime = fs.statSync(DEVICE_FILE).mtimeMs;
  } catch {
    mtime = -1;
  }
  if (mtime === -1) {
    deviceCache = null;
    return null;
  }
  if (deviceCache !== null && mtime === deviceMtime) return deviceCache;
  try {
    deviceCache = JSON.parse(fs.readFileSync(DEVICE_FILE, 'utf8')) as DeviceIdentity;
    deviceMtime = mtime;
  } catch {
    deviceCache = null;
  }
  return deviceCache;
}

export function writeDevice(device: DeviceIdentity): void {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  fs.writeFileSync(DEVICE_FILE, JSON.stringify(device, null, 2), { mode: 0o600 });
  deviceCache = device;
  deviceMtime = fs.statSync(DEVICE_FILE).mtimeMs;
}

/** 把 `a=1; b=2` 合并进已有 cookie，同名覆盖，其余保留。 */
export function mergeCookie(existing: string, incoming: string): string {
  const map = new Map<string, string>();
  for (const part of existing.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  for (const part of incoming.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join('; ');
}

export function cookieCount(cookie: string): number {
  return cookie === '' ? 0 : cookie.split(';').filter((p) => p.includes('=')).length;
}
