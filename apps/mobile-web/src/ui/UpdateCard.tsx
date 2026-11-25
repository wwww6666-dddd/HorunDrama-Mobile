import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { createPortal } from 'react-dom';
import {
  APP_VERSION,
  checkUpdate,
  compareVersion,
  openExternalUrl,
  type UpdateAsset,
  type UpdateInfo,
} from '../app-info.ts';
import { useApp } from '../store.ts';

type DownloadState = 'idle' | 'downloading' | 'ready' | 'error';

interface DownloadInfo {
  state: DownloadState;
  percent: number;
  path: string;
  message: string;
  /** 主进程实际下载方式；'single' 表示多连接不可用（会明显变慢） */
  mode: 'parallel' | 'single' | '';
}

/** 只选择项目发布的 portable zip；主进程会再次校验仓库、版本和资产名。 */
function pickAsset(assets: UpdateAsset[]): UpdateAsset | null {
  return assets.find((a) => /^HorunDrama-\d+\.\d+\.\d+-win64-portable\.zip$/i.test(a.name)) ?? null;
}

/**
 * 自动更新卡片（2.0.1 参考成熟客户端的“后台下载 + 一键重启更新”）。
 *
 * 流程：启动 3 秒后查 GitHub Releases → 发现新版本 → 后台下载完整包 →
 * 用户点“立即重启更新” → main 进程写一个等待退出、解压覆盖、重新启动的脚本。
 * 数据目录不在更新包里，设置/登录/缓存保留。
 */
export function UpdateCard(): JSX.Element | null {
  const openReward = useApp((s) => s.openReward);
  const info = useApp((s) => s.updateInfo);
  const setInfo = useApp((s) => s.setUpdateInfo);
  const open = useApp((s) => s.updateCardOpen);
  const closeCard = useApp((s) => s.closeUpdateCard);
  const [dl, setDl] = useState<DownloadInfo>({ state: 'idle', percent: 0, path: '', message: '', mode: '' });
  const [installing, setInstalling] = useState(false);
  // 全屏时 portal 到全屏元素，否则更新卡片会被藏掉
  const [root, setRoot] = useState<HTMLElement>(
    () => (document.fullscreenElement as HTMLElement | null) ?? document.body,
  );

  useEffect(() => {
    const sync = (): void => setRoot((document.fullscreenElement as HTMLElement | null) ?? document.body);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  useEffect(() => {
    let alive = true;
    let timer = 0;

    /** 查一次更新；失败静默（离线/仓库没发版都算正常）。 */
    const check = async (): Promise<void> => {
      try {
        const next = await checkUpdate();
        if (!alive || next.latest === '') return;
        if (compareVersion(next.latest, APP_VERSION) <= 0) return;
        setInfo(next);
      } catch {
        /* 静默：关于页还有手动"检查更新" */
      }
    };

    // 首屏先让播放器/首页起来，3 秒后再查，避免和取流抢网络
    timer = window.setTimeout(() => void check(), 3000);
    const interval = window.setInterval(() => void check(), 6 * 60 * 60 * 1000);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, []);

  /** 后台下载更新包；主进程按块回报进度。 */
  const startDownload = async (target: UpdateInfo): Promise<void> => {
    const asset = pickAsset(target.assets);
    const bridge = window.yimu;
    if (asset === null || bridge?.updateDownload === undefined) {
      setDl({ state: 'error', percent: 0, path: '', message: '请在 GitHub Releases 手动下载', mode: '' });
      return;
    }
    setDl({ state: 'downloading', percent: 0, path: '', message: '正在后台下载更新包…', mode: '' });
    const off = bridge.onUpdateProgress?.((p) => {
      setDl((prev) =>
        prev.state === 'downloading'
          ? {
              ...prev,
              percent: Math.max(prev.percent, Math.min(1, p.percent)),
              mode: p.mode ?? prev.mode,
              message: p.mode === 'single' ? '多连接不可用，已退回单连接下载（可能较慢）…' : '正在后台下载更新包…',
            }
          : prev,
      );
    });
    try {
      const res = await bridge.updateDownload({
        url: asset.url,
        name: asset.name,
        size: asset.size,
        digest: asset.digest,
      });
      if (res.ok && res.path !== undefined) {
        setDl({ state: 'ready', percent: 1, path: res.path, message: '下载完成，可以立即重启更新', mode: res.mode ?? '' });
      } else {
        setDl({ state: 'error', percent: 0, path: '', message: res.message ?? '下载失败', mode: '' });
      }
    } catch (err) {
      setDl({ state: 'error', percent: 0, path: '', message: (err as Error).message, mode: '' });
    } finally {
      off?.();
    }
  };

  // 发现新版本后自动开始后台下载（浏览器里没有 IPC，就只显示链接）
  useEffect(() => {
    if (info === null) return;
    const timer = window.setTimeout(() => void startDownload(info), 600);
    return () => window.clearTimeout(timer);
    // 只在 info 变化时启动一次；startDownload 内部只依赖当前 info
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info]);

  if (info === null || !open) return null;

  /** 关闭卡片但保留顶栏更新按钮，用户随时可以再打开。 */
  const dismiss = (): void => {
    closeCard();
  };

  /** 退出并应用更新（main 会等待进程退出后解压覆盖并重启）。 */
  const install = async (): Promise<void> => {
    if (dl.state !== 'ready' || dl.path === '') return;
    const bridge = window.yimu;
    if (bridge?.updateInstall === undefined) {
      openExternalUrl(info.url);
      return;
    }
    setInstalling(true);
    try {
      const res = await bridge.updateInstall({ path: dl.path });
      if (!res.ok) {
        setInstalling(false);
        setDl((prev) => ({ ...prev, state: 'error', message: res.message ?? '应用更新失败' }));
      }
      // 成功时应用马上退出，这里不用改状态
    } catch (err) {
      setInstalling(false);
      setDl((prev) => ({ ...prev, state: 'error', message: (err as Error).message }));
    }
  };

  const primaryLabel =
    dl.state === 'downloading'
      ? `下载中 ${Math.round(dl.percent * 100)}%`
      : dl.state === 'ready'
        ? installing
          ? '正在重启更新…'
          : '立即重启更新'
        : dl.state === 'error'
          ? '重试下载'
          : '查看更新说明';

  const onPrimary = (): void => {
    if (dl.state === 'downloading') return;
    if (dl.state === 'ready') {
      void install();
      return;
    }
    if (dl.state === 'error') {
      void startDownload(info);
      return;
    }
    openExternalUrl(info.url);
  };

  return createPortal(
    <div className="update-pop" role="dialog" aria-label="发现新版本">
      <div className="update-pop__glow" aria-hidden="true" />
      <div className="update-pop__head">
        <span className="update-pop__icon" aria-hidden="true">
          ↑
        </span>
        <div className="update-pop__headline">
          <strong>发现新版本 v{info.latest}</strong>
          <span>
            当前 v{APP_VERSION}
            {info.publishedAt !== '' && ` · ${info.publishedAt.slice(0, 10)} 发布`}
          </span>
        </div>
        <button className="update-pop__close" onClick={dismiss} aria-label="关闭更新提示">
          关闭 <span aria-hidden="true">✕</span>
        </button>
      </div>

      {info.name !== '' && <p className="update-pop__name">{info.name}</p>}
      <p className="update-pop__text">
        {dl.state === 'downloading'
          ? dl.mode === 'single'
            ? '多连接不可用，已退回单连接下载（可能较慢）。下载完成后点“立即重启更新”即可，数据、登录和缓存都会保留。'
            : '新版本正在后台下载，下载完成后点“立即重启更新”即可，数据、登录和缓存都会保留。'
          : dl.state === 'ready'
            ? '更新包已下载完成。点“立即重启更新”会退出程序、覆盖新版本并自动重新打开。'
            : dl.state === 'error'
              ? `自动下载不可用：${dl.message}。也可以点“查看更新说明”手动下载。`
              : '新版本已经发布，正在检查更新包。本次更新完全自愿；如果这个软件帮到了你，也欢迎自愿打赏支持作者。'}
      </p>

      {dl.state === 'downloading' && (
        <div className="update-pop__progress" aria-label="下载进度">
          <span style={{ width: `${Math.round(dl.percent * 100)}%` }} />
        </div>
      )}

      <div className="update-pop__actions">
        <button
          className="btn btn--primary"
          disabled={dl.state === 'downloading' || installing}
          onClick={onPrimary}
        >
          {primaryLabel}
        </button>
        <button className="btn btn--ghost" onClick={() => openExternalUrl(info.url)}>
          更新说明
        </button>
        <button
          className="btn"
          onClick={() => {
            openReward();
          }}
        >
          ♥ 打赏（自愿）
        </button>
        <button className="btn btn--ghost" onClick={dismiss}>
          稍后提醒
        </button>
      </div>
      <p className="update-pop__hint">
        更新会保留 data 目录；下载/解压失败不会先动现有程序。打赏二维码在「打赏作者」里。
      </p>
    </div>,
    root,
  );
}
