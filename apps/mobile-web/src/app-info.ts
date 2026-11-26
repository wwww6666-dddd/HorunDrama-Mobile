/**
 * 客户端版本号与项目地址（关于页 / 打赏页 / 反馈 / 更新 都用这里的常量）。
 *
 * 版本号在构建时由 `vite.config.ts` 的 `define` 注入，来源是
 * `apps/desktop/package.json` 的 `version` —— 也就是安装包/绿色包的真实版本，
 * 不要在前端再硬编码一份。
 */
declare const __APP_VERSION__: string;

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

/** 作者名（关于页、打赏页统一用这个常量） */
export const APP_AUTHOR = 'Horun';

/** GitHub 仓库（owner/name）—— 更新检查、反馈、源码地址都指向这里 */
export const GITHUB_REPO = 'wwww6666-dddd/HorunDrama';
/** 手机端单独一个仓库：只有手机代码和 APK，桌面端更新不受影响 */
export const MOBILE_GITHUB_REPO = 'wwww6666-dddd/HorunDrama-Mobile';
export const MOBILE_GITHUB_URL = `https://github.com/${MOBILE_GITHUB_REPO}`;
export const MOBILE_FEEDBACK_URL = `${MOBILE_GITHUB_URL}/issues/new`;
export const MOBILE_RELEASES_URL = `${MOBILE_GITHUB_URL}/releases`;
export const MOBILE_UPDATE_API_URL = `https://api.github.com/repos/${MOBILE_GITHUB_REPO}/releases/latest`;

/**
 * GitHub 在国内经常直连超时，检查更新和下载都走多源。
 * 2026-11 实测：gh-proxy.com 超时，gh-proxy.org（官方新域名）与 api.gitproxy.dev 可用；
 * 两者都透传 Range，能跑分段下载。旧的 .com/.net 保留作为兜底。
 */
const MOBILE_MIRROR_PREFIXES = ['https://gh-proxy.org/', 'https://gh-proxy.com/'];
/**
 * 下载线路：只列实测能连的，排在前面的先试。
 * api.gitproxy.dev 的路径格式是 /github.com/owner/repo/...（不带 https://）。
 */
const MOBILE_DOWNLOAD_MIRRORS = ['https://gh-proxy.org/', 'https://api.gitproxy.dev/', 'https://ghproxy.net/', 'https://gh-proxy.com/'];

export function mobileUpdateApiSources(): string[] {
  return [
    `${MOBILE_MIRROR_PREFIXES[0]}${MOBILE_UPDATE_API_URL}`,
    MOBILE_UPDATE_API_URL,
    ...MOBILE_MIRROR_PREFIXES.slice(1).map((prefix) => `${prefix}${MOBILE_UPDATE_API_URL}`),
  ];
}

/** 给原生 UpdateManager 的多源下载串：镜像优先、GitHub 原站兜底，用 | 分隔 */
export function mobileUpdateAssetSources(assetUrl: string): string {
  if (assetUrl === '') return '';
  const candidates: string[] = [];
  for (const prefix of MOBILE_DOWNLOAD_MIRRORS) {
    if (prefix.includes('api.gitproxy.dev')) {
      candidates.push(`${prefix}${assetUrl.replace(/^https:\/\//, '')}`);
    } else {
      candidates.push(`${prefix}${assetUrl}`);
    }
  }
  candidates.push(assetUrl);
  return candidates.join('|');
}
export const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;
/** 反馈（新建 issue） */
export const FEEDBACK_URL = `${GITHUB_URL}/issues/new`;
/** 更新 / 下载地址 */
export const RELEASES_URL = `${GITHUB_URL}/releases`;
/** 更新检查（GitHub Releases API；api.github.com 允许跨域，前端直接查） */
export const UPDATE_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

/** 语义化版本比较：a>b 返回 1，相等 0，a<b 返回 -1。非数字段按 0 处理。 */
export function compareVersion(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map((s) => Number.parseInt(s, 10) || 0);
  const pb = b.replace(/^v/i, '').split('.').map((s) => Number.parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

export interface UpdateAsset {
  name: string;
  url: string;
  size: number;
  /** GitHub 新 API 会给 "sha256:..."；旧数据可能为空 */
  digest: string;
  contentType: string;
}

export interface UpdateInfo {
  latest: string;
  url: string;
  name: string;
  publishedAt: string;
  notes: string;
  assets: UpdateAsset[];
  /** 所有在线检查线路都失败时，返回的是 localStorage 上次成功结果 */
  fromCache?: boolean;
}

/**
 * 查 GitHub 最新 release。
 * 查不到就抛错（调用方显示"检查失败"），不阻塞任何播放功能。
 */
export async function checkUpdate(): Promise<UpdateInfo> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(UPDATE_API_URL, {
      signal: controller.signal,
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      // 仓库刚建好、还没发 release 时是 404，这不算错误，给个明确说法
      if (res.status === 404) throw new Error('还没有发布 release');
      throw new Error(`GitHub 返回 ${res.status}`);
    }
    const json = (await res.json()) as {
      tag_name?: string;
      html_url?: string;
      name?: string;
      published_at?: string;
      body?: string;
      assets?: Array<{
        name?: string;
        browser_download_url?: string;
        size?: number;
        digest?: string;
        content_type?: string;
      }>;
    };
    return {
      latest: (json.tag_name ?? '').replace(/^v/i, ''),
      url: json.html_url ?? RELEASES_URL,
      name: json.name ?? '',
      publishedAt: json.published_at ?? '',
      notes: json.body ?? '',
      assets: (json.assets ?? [])
        .filter((a) => typeof a.browser_download_url === 'string' && a.browser_download_url !== '')
        .map((a) => ({
          name: a.name ?? '',
          url: a.browser_download_url ?? '',
          size: typeof a.size === 'number' ? a.size : 0,
          digest: a.digest ?? '',
          contentType: a.content_type ?? '',
        })),
    };
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * 手机端检查更新：GitHub 原站 + 镜像并发，谁先返回用谁。
 * 这样 GitHub 超时不会把整个检查卡死，也不会误报“已是最新”。
 */
export async function checkMobileUpdate(): Promise<UpdateInfo> {
  const sources = mobileUpdateApiSources();
  const attempts = sources.map((source, index) => fetchMobileUpdateSource(source, index === 0 ? 7000 : 9000));
  try {
    return await Promise.any(attempts);
  } catch {
    const cached = readCachedMobileUpdate();
    if (cached !== null) {
      // 全部线路都断时，至少列出上次成功拿到的版本；界面会注明是缓存结果。
      return { ...cached, fromCache: true };
    }
    throw new Error('GitHub 和更新镜像都连不上，请换网络后再试');
  }
}

async function fetchMobileUpdateSource(source: string, timeoutMs: number): Promise<UpdateInfo> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${source}?t=${Date.now()}`, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { accept: 'application/vnd.github+json', 'cache-control': 'no-cache' },
    });
    if (!res.ok) {
      if (res.status === 404) throw new Error('手机仓库还没有发布 release');
      throw new Error(`GitHub 返回 ${res.status}`);
    }
    const json = (await res.json()) as {
      tag_name?: string;
      html_url?: string;
      name?: string;
      published_at?: string;
      body?: string;
      assets?: Array<{
        name?: string;
        browser_download_url?: string;
        size?: number;
        digest?: string;
        content_type?: string;
      }>;
    };
    const info: UpdateInfo = {
      latest: (json.tag_name ?? '').replace(/^v/i, ''),
      url: json.html_url ?? MOBILE_RELEASES_URL,
      name: json.name ?? '',
      publishedAt: json.published_at ?? '',
      notes: json.body ?? '',
      assets: (json.assets ?? [])
        .filter((a) => typeof a.browser_download_url === 'string' && a.browser_download_url !== '')
        .map((a) => ({
          name: a.name ?? '',
          url: a.browser_download_url ?? '',
          size: typeof a.size === 'number' ? a.size : 0,
          digest: a.digest ?? '',
          contentType: a.content_type ?? '',
        })),
    };
    if (info.latest === '') throw new Error('更新接口没有返回版本号');
    try {
      localStorage.setItem('horun-update-cache', JSON.stringify(info));
    } catch {
      /* 隐私模式忽略 */
    }
    return info;
  } finally {
    window.clearTimeout(timer);
  }
}

function readCachedMobileUpdate(): UpdateInfo | null {
  try {
    const raw = localStorage.getItem('horun-update-cache');
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as UpdateInfo;
    if (typeof parsed.latest !== 'string' || !Array.isArray(parsed.assets)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 *
 * 优先走 Electron 的 clipboard（main 进程，必定可用 —— 无焦点窗口/权限策略下
 * 渲染进程的 navigator.clipboard 会被拒）；浏览器里退回 navigator.clipboard。
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  const bridge = (window as unknown as { yimu?: { copyText?: (t: string) => Promise<boolean> } }).yimu;
  if (typeof bridge?.copyText === 'function') {
    try {
      return await bridge.copyText(text);
    } catch {
      /* 落到下面 */
    }
  }
  if (navigator.clipboard === undefined) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 用系统浏览器打开外链。
 *
 * 渲染进程里不能直接 `location.href = ...`（会把应用本身导航走），
 * Electron 走 preload 暴露的 `yimu.openExternal`（main 里 shell.openExternal）；
 * 浏览器里（dev 你用 localhost 打开）退回 window.open。
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  /** 浏览器兜底：window.open 在桌面壳里会被 main.cjs 的 setWindowOpenHandler
   *  转成 shell.openExternal，所以即使 preload 的桥没注入也仍然能跳。 */
  const browserFallback = (): boolean => {
    try {
      const win = window.open(url, '_blank', 'noopener,noreferrer');
      return win !== null;
    } catch {
      return false;
    }
  };
  const bridge = (window as unknown as { yimu?: { openExternal?: (u: string) => Promise<unknown> } }).yimu;
  if (bridge?.openExternal !== undefined) {
    try {
      const ok = await bridge.openExternal(url);
      if (ok !== false) return true;
      // shell.openExternal 返回 false：在 Electron 里退回 location 导航，
      // main 的 will-navigate 会拦截并再次用系统浏览器打开。
      if (window.yimu !== undefined) {
        location.href = url;
        return true;
      }
    } catch {
      /* 落到 browserFallback */
    }
  }
  return browserFallback();
}
