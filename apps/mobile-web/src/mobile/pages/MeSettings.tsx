import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { api, type Settings as SettingsData } from '../../api.ts';
import { APP_VERSION, checkMobileUpdate, compareVersion, openExternalUrl, type UpdateInfo } from '../../app-info.ts';
import { useAsync } from '../../hooks/useAsync.ts';
import { useApp, type Accent, type ThemeMode } from '../../store.ts';
import { useNav } from '../nav.tsx';
import { Icon, Switch } from '../ui.tsx';
import { LoginSheet } from '../LoginSheet.tsx';

const ACCENTS: Array<{ value: Accent; label: string; color: string }> = [
  { value: 'ember', label: '暖橙', color: '#ff5a37' },
  { value: 'crimson', label: '朱红', color: '#ff2d55' },
  { value: 'jade', label: '青玉', color: '#2fbf9b' },
  { value: 'violet', label: '暮紫', color: '#8b5cf6' },
  { value: 'azure', label: '远蓝', color: '#3b82f6' },
  { value: 'gold', label: '暖金', color: '#d9a13b' },
];

const SPEEDS = ['0.75', '1', '1.25', '1.5', '2'];
const QUALITIES: Array<{ value: SettingsData['defaultQuality']; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: '1080p', label: '1080P' },
  { value: '720p', label: '720P' },
  { value: '480p', label: '480P' },
  { value: 'smooth', label: '流畅' },
];
const CACHE_LIMITS = [1024, 2048, 4096, 8192, 16384, 32768];
const PRELOAD_COUNTS = [0, 3, 5, 10];
const FONT_SCALES: Array<{ value: number; label: string }> = [
  { value: 90, label: '小' },
  { value: 100, label: '标准' },
  { value: 112, label: '大' },
  { value: 125, label: '特大' },
];

function mb(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function gb(megabytes: number): string {
  if (megabytes >= 1024) return `${(megabytes / 1024).toFixed(megabytes % 1024 === 0 ? 0 : 1)} GB`;
  return `${megabytes} MB`;
}

function SRow({
  label,
  hint,
  right,
  onClick,
}: {
  label: string;
  hint?: string;
  right?: JSX.Element;
  onClick?: () => void;
}): JSX.Element {
  const inner = (
    <>
      <span className="ms-row__text">
        <b>{label}</b>
        {hint !== undefined && <span>{hint}</span>}
      </span>
      {right ?? (onClick !== undefined ? <Icon name="chevron" size={16} /> : null)}
    </>
  );
  if (onClick === undefined) return <div className="ms-row">{inner}</div>;
  return (
    <button type="button" className="ms-row" onClick={onClick}>
      {inner}
    </button>
  );
}

function Seg<T extends string | number>({
  value,
  options,
  onPick,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onPick: (value: T) => void;
}): JSX.Element {
  return (
    <div className="ms-seg">
      {options.map((item) => (
        <button type="button" key={String(item.value)} data-active={String(value) === String(item.value)} onClick={() => onPick(item.value)}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function MeSettings(): JSX.Element {
  const { go } = useNav();
  const theme = useApp((s) => s.theme);
  const themeMode = useApp((s) => s.themeMode);
  const setThemeMode = useApp((s) => s.setThemeMode);
  const accent = useApp((s) => s.accent);
  const setAccent = useApp((s) => s.setAccent);
  const account = useApp((s) => s.account);
  const refreshAccount = useApp((s) => s.refreshAccount);
  const setAccount = useApp((s) => s.setAccount);

  const settings = useAsync((signal) => api.settings(signal), []);
  const cache = useAsync((signal) => api.cacheStats(signal), []);
  const [draft, setDraft] = useState<SettingsData | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [fontScale, setFontScale] = useState(() => Number(localStorage.getItem('horun-font-scale') ?? '100') || 100);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateNote, setUpdateNote] = useState('');
  const [checking, setChecking] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(() => localStorage.getItem('horun-auto-update') !== '0');

  useEffect(() => {
    void refreshAccount();
  }, [refreshAccount]);

  useEffect(() => {
    if (settings.data !== null) setDraft(settings.data);
  }, [settings.data]);

  useEffect(() => {
    window.HorunAndroid?.setFontScale?.(fontScale);
  }, [fontScale]);

  const patch = (next: Partial<SettingsData>): void => {
    setDraft((prev) => ({ ...(prev ?? (settings.data as SettingsData)), ...next }));
    void api
      .saveSettings(next)
      .then(() => {
        settings.reload();
        cache.reload();
      })
      .catch((err: unknown) => setNote(`保存失败：${(err as Error).message}`));
  };

  const logout = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.accountLogout();
      setAccount(null);
      setNote('已退出登录');
    } finally {
      setBusy(false);
    }
  };

  const pickFont = (value: number): void => {
    setFontScale(value);
    localStorage.setItem('horun-font-scale', String(value));
    window.HorunAndroid?.setFontScale?.(value);
  };

  const checkForUpdate = async (): Promise<void> => {
    setChecking(true);
    setUpdate(null);
    setUpdateNote('');
    try {
      const info = await checkMobileUpdate();
      if (compareVersion(info.latest, APP_VERSION) > 0) {
        setUpdate(info);
        setUpdateNote(`发现新版本 v${info.latest}（当前 ${APP_VERSION}）`);
      } else {
        setUpdateNote(`已经是最新版本 v${APP_VERSION}`);
      }
    } catch (err) {
      setUpdateNote(`检查更新失败：${(err as Error).message}`);
    } finally {
      setChecking(false);
    }
  };

  const downloadUpdate = (): void => {
    const asset = update?.assets.find((item) => item.name.toLowerCase().endsWith('.apk')) ?? update?.assets[0];
    if (asset === undefined) {
      setUpdateNote('这个 release 没有 APK 附件');
      return;
    }
    const native = window.HorunAndroid?.downloadUpdate;
    if (typeof native === 'function') {
      native(asset.url, asset.name || 'HorunDrama-update.apk', asset.digest, 4);
      setUpdateNote('已在后台多线程下载，完成后会弹出系统安装界面');
    } else {
      void openExternalUrl(asset.url);
    }
  };

  const data = draft ?? settings.data;
  const speed = data?.defaultSpeed ?? 1;
  const quality = data?.defaultQuality ?? 'auto';
  const loggedIn = account !== null && account.loggedIn;

  return (
    <div className="ms">
      <div className="ms-card">
        {loggedIn ? (
          <>
            <SRow label="账号" hint={`${account.nickname} · 已登录`} right={<span className="ms-pill">已连接</span>} />
            <SRow
              label="同步账号数据"
              hint="收藏 / 历史 / 追更 / 预约"
              onClick={() => {
                void api
                  .accountSync(true)
                  .then((r) => setNote(r.message))
                  .catch((err: unknown) => setNote(`同步失败：${(err as Error).message}`));
              }}
            />
            <SRow label="退出登录" onClick={() => void logout()} right={<span className="ms-danger">退出</span>} />
          </>
        ) : (
          <SRow label="手机号登录" hint="登录后同步收藏 / 追剧记录" onClick={() => setLoginOpen(true)} right={<span className="ms-pill">登录</span>} />
        )}
      </div>

      <h3 className="ms-title">外观</h3>
      <div className="ms-card">
        <div className="ms-row ms-row--stack">
          <span className="ms-row__text">
            <b>深浅模式</b>
            <span>当前：{theme === 'dark' ? '深色' : '浅色'}{themeMode === 'system' ? '（跟随系统）' : ''}</span>
          </span>
          <Seg<ThemeMode>
            value={themeMode}
            options={[
              { value: 'system', label: '跟随系统' },
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' },
            ]}
            onPick={(value) => setThemeMode(value)}
          />
        </div>
        <div className="ms-row ms-row--stack">
          <span className="ms-row__text">
            <b>主题色</b>
            <span>按钮、选中态、高亮和页面底色会跟着变</span>
          </span>
          <div className="ms-swatches">
            {ACCENTS.map((item) => (
              <button
                type="button"
                key={item.value}
                className="ms-swatch"
                data-active={accent === item.value}
                style={{ background: item.color }}
                aria-label={item.label}
                onClick={() => setAccent(item.value)}
              >
                {accent === item.value && <Icon name="check" size={14} />}
              </button>
            ))}
          </div>
        </div>
        <div className="ms-row ms-row--stack">
          <span className="ms-row__text">
            <b>字体大小</b>
            <span>按系统字号缩放整个界面</span>
          </span>
          <Seg<number> value={fontScale} options={FONT_SCALES} onPick={pickFont} />
        </div>
      </div>

      <h3 className="ms-title">播放</h3>
      <div className="ms-card">
        <SRow
          label="自动播放下一集"
          hint="一集播完直接进入下一集，也支持上下滑切集"
          right={<Switch on={data?.autoPlayNext !== false} onChange={(v) => patch({ autoPlayNext: v })} />}
        />
        <div className="ms-row ms-row--stack">
          <span className="ms-row__text">
            <b>默认倍速</b>
            <span>当前 {speed === 1 ? '1×' : `${speed}×`}</span>
          </span>
          <Seg<string>
            value={String(speed)}
            options={SPEEDS.map((value) => ({ value, label: value === '1' ? '1×' : `${value}×` }))}
            onPick={(value) => patch({ defaultSpeed: Number(value) })}
          />
        </div>
        <div className="ms-row ms-row--stack">
          <span className="ms-row__text">
            <b>默认清晰度</b>
            <span>高清需要上游可用；不可用时会自动退流畅线路</span>
          </span>
          <Seg<SettingsData['defaultQuality']> value={quality} options={QUALITIES} onPick={(value) => patch({ defaultQuality: value })} />
        </div>
        <div className="ms-row ms-row--stack">
          <span className="ms-row__text">
            <b>预加载集数</b>
            <span>前后各预取几集，越大越顺但更占缓存</span>
          </span>
          <Seg<number>
            value={data?.preloadCount ?? 5}
            options={PRELOAD_COUNTS.map((value) => ({ value, label: value === 0 ? '关闭' : `前后 ${value} 集` }))}
            onPick={(value) => patch({ preloadCount: value })}
          />
        </div>
        <div className="ms-row ms-row--stack">
          <span className="ms-row__text">
            <b>跳过片头 / 片尾</b>
            <span>0 秒表示不跳；片尾到点后自动下一集</span>
          </span>
          <div className="ms-steppers">
            <label>
              片头
              <input
                type="number"
                min={0}
                max={300}
                value={data?.skipIntroSec ?? 0}
                onChange={(event) => patch({ skipIntroSec: Math.max(0, Math.min(300, Number(event.target.value) || 0)) })}
              />
              秒
            </label>
            <label>
              片尾
              <input
                type="number"
                min={0}
                max={300}
                value={data?.skipOutroSec ?? 0}
                onChange={(event) => patch({ skipOutroSec: Math.max(0, Math.min(300, Number(event.target.value) || 0)) })}
              />
              秒
            </label>
          </div>
        </div>
        <SRow
          label="新集提醒"
          hint="在追剧页给有新集的剧打标"
          right={<Switch on={data?.notifyNewEpisodes !== false} onChange={(v) => patch({ notifyNewEpisodes: v })} />}
        />
      </div>

      <h3 className="ms-title">存储</h3>
      <div className="ms-card">
        <SRow
          label="媒体缓存"
          hint={cache.data !== null ? `${cache.data.media.count} 个文件 · 已用 ${mb(cache.data.media.bytes)}` : '读取中'}
          right={<span className="ms-pill">{gb(data?.mediaCacheMB ?? 4096)}</span>}
        />
        <div className="ms-row ms-row--stack">
          <span className="ms-row__text">
            <b>缓存上限</b>
            <span>达到上限自动按最旧文件清理，不用手动删</span>
          </span>
          <Seg<number>
            value={data?.mediaCacheMB ?? 4096}
            options={CACHE_LIMITS.map((value) => ({ value, label: gb(value) }))}
            onPick={(value) => patch({ mediaCacheMB: value })}
          />
        </div>
        <SRow
          label="封面 / 图片缓存"
          hint={cache.data !== null ? `${cache.data.images.count} 张 · ${mb(cache.data.images.bytes)} / ${mb(cache.data.images.limit)}` : '读取中'}
        />
        <SRow
          label="清理媒体缓存"
          onClick={() => {
            void api
              .clearCache('media')
              .then(() => {
                setNote('媒体缓存已清理');
                cache.reload();
              })
              .catch((err: unknown) => setNote(`清理失败：${(err as Error).message}`));
          }}
          right={<span className="ms-pill">清理</span>}
        />
        <SRow
          label="清理图片缓存"
          onClick={() => {
            void api
              .clearCache('images')
              .then(() => {
                setNote('图片缓存已清理');
                cache.reload();
              })
              .catch((err: unknown) => setNote(`清理失败：${(err as Error).message}`));
          }}
          right={<span className="ms-pill">清理</span>}
        />
        <SRow label="下载管理" onClick={() => go('downloads')} />
      </div>

      <h3 className="ms-title">更新</h3>
      <div className="ms-card">
        <SRow
          label="当前版本"
          hint={`手机端 v${APP_VERSION}`}
          right={<span className="ms-pill">{window.HorunAndroid?.getUpdateState?.() === 'downloading' ? '下载中' : '正式版'}</span>}
        />
        <SRow
          label="自动更新"
          hint="每天检查一次，后台四线程下载，完成后提示安装"
          right={
            <Switch
              on={autoUpdate}
              onChange={(v) => {
                setAutoUpdate(v);
                localStorage.setItem('horun-auto-update', v ? '1' : '0');
                if (v) localStorage.removeItem('horun-auto-check');
              }}
            />
          }
        />
        <SRow label="检查更新" hint="从 GitHub Releases 获取最新 APK" onClick={() => void checkForUpdate()} right={<span className="ms-pill">{checking ? '检查中' : '检查'}</span>} />
        {update !== null && (
          <SRow
            label={`下载 v${update.latest}`}
            hint="四线程分段下载，断点续传，完成后自动唤起安装"
            onClick={downloadUpdate}
            right={<span className="ms-pill">下载</span>}
          />
        )}
        {(updateNote !== '' || note !== '') && <p className="ms-inline-note">{updateNote || note}</p>}
      </div>

      <h3 className="ms-title">更多</h3>
      <div className="ms-card">
        <SRow label="服务地址" hint={window.HorunAndroid?.getServerUrl() ?? location.origin} />
        <SRow label="隐私说明" hint="本机记录只存在设备上，不上传" onClick={() => void openExternalUrl('https://github.com/wwww6666-dddd/HorunDrama-Mobile#隐私')} />
        <SRow label="问题反馈" onClick={() => void openExternalUrl('https://github.com/wwww6666-dddd/HorunDrama-Mobile/issues/new')} />
        <SRow label="关于 HorunDrama 手机端" onClick={() => go('about')} />
        <SRow label="新剧日历" onClick={() => go('new')} />
        <SRow label="分类筛选" onClick={() => go('category')} />
      </div>

      {(note !== '' || busy) && <p className="ms-note">{busy ? '处理中…' : note}</p>}
      <p className="ms-foot">解析、解码、下载、缓存都在手机本机完成，App 可独立运行。缓存与账号数据保存在本机应用目录。</p>

      <LoginSheet
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        onDone={() => {
          setNote('登录成功');
          settings.reload();
        }}
      />
    </div>
  );
}

