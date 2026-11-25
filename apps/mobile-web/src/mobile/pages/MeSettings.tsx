import { useEffect, useState } from 'react';
import type { JSX, MouseEvent } from 'react';
import { api, type Settings as SettingsData } from '../../api.ts';
import { useAsync } from '../../hooks/useAsync.ts';
import { useApp, type Accent } from '../../store.ts';
import { useNav } from '../nav.tsx';
import { Icon, Switch } from '../ui.tsx';
import { LoginSheet } from '../LoginSheet.tsx';

const ACCENTS: Array<{ value: Accent; label: string; color: string }> = [
  { value: 'ember', label: '暖橙', color: '#ff4d2e' },
  { value: 'jade', label: '青玉', color: '#2fbf9b' },
  { value: 'violet', label: '暮紫', color: '#8b5cf6' },
  { value: 'azure', label: '远蓝', color: '#3b82f6' },
];

const SPEEDS = ['0.75', '1', '1.25', '1.5', '2'];

function mb(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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

export function MeSettings(): JSX.Element {
  const { go } = useNav();
  const theme = useApp((s) => s.theme);
  const toggleTheme = useApp((s) => s.toggleTheme);
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

  useEffect(() => {
    void refreshAccount();
  }, [refreshAccount]);

  useEffect(() => {
    if (settings.data !== null) setDraft(settings.data);
  }, [settings.data]);

  const patch = (next: Partial<SettingsData>): void => {
    setDraft((prev) => ({ ...(prev ?? (settings.data as SettingsData)), ...next }));
    void api
      .saveSettings(next)
      .then(() => settings.reload())
      .catch((err: unknown) => setNote(`保存失败：${(err as Error).message}`));
  };

  const logout = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.accountLogout();
      setAccount(null);
      setNote('已退出登录');
    } catch (err) {
      setNote(`退出失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  /** 主题切换：支持 View Transition 时从开关位置圆形扩散，老 WebView 直接切。 */
  const switchTheme = (next: boolean, event: MouseEvent<HTMLButtonElement>): void => {
    if (next === (theme === 'dark')) return;
    const doc = document as Document & {
      startViewTransition?: (run: () => void) => { ready: Promise<void> };
    };
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion || typeof doc.startViewTransition !== 'function') {
      toggleTheme();
      return;
    }
    const x = event.clientX;
    const y = event.clientY;
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const transition = doc.startViewTransition(() => toggleTheme());
    void transition.ready
      .then(() => {
        document.documentElement.animate(
          [
            { clipPath: `circle(0px at ${x}px ${y}px)` },
            { clipPath: `circle(${radius}px at ${x}px ${y}px)` },
          ],
          {
            duration: 520,
            easing: 'cubic-bezier(0.32, 0.72, 0, 1)',
            pseudoElement: '::view-transition-new(root)',
          } as KeyframeAnimationOptions & { pseudoElement: string },
        );
      })
      .catch(() => {
        /* 主题已经切过去；过渡被打断不影响 */
      });
  };

  const data = draft ?? settings.data;
  const speed = data?.defaultSpeed ?? 1;
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
          <SRow label="手机号登录" hint="与电脑端同一个手机号" onClick={() => setLoginOpen(true)} right={<span className="ms-pill">登录</span>} />
        )}
      </div>

      <h3 className="ms-title">播放</h3>
      <div className="ms-card">
        <SRow
          label="自动播放下一集"
          hint="一集播完直接进入下一集"
          right={<Switch on={data?.autoPlayNext !== false} onChange={(v) => patch({ autoPlayNext: v })} />}
        />
        <div className="ms-row ms-row--stack">
          <span className="ms-row__text">
            <b>默认倍速</b>
            <span>当前 {speed === 1 ? '1×' : `${speed}×`}</span>
          </span>
          <div className="ms-seg">
            {SPEEDS.map((value) => (
              <button type="button" key={value} data-active={String(speed) === value} onClick={() => patch({ defaultSpeed: Number(value) })}>
                {value === '1' ? '1×' : `${value}×`}
              </button>
            ))}
          </div>
        </div>
        <SRow
          label="新集提醒"
          hint="在追剧页给有新集的剧打标"
          right={<Switch on={data?.notifyNewEpisodes !== false} onChange={(v) => patch({ notifyNewEpisodes: v })} />}
        />
      </div>

      <h3 className="ms-title">外观</h3>
      <div className="ms-card">
        <SRow
          label="深色播放界面"
          hint={theme === 'dark' ? '当前：深色（推荐流 / 播放器）' : '当前：浅色'}
          right={<Switch on={theme === 'dark'} onChange={(next, event) => switchTheme(next, event)} />}
        />
        <div className="ms-row ms-row--stack">
          <span className="ms-row__text">
            <b>主题色</b>
            <span>只影响按钮和高亮，不改变页面底色</span>
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
      </div>

      <h3 className="ms-title">存储</h3>
      <div className="ms-card">
        <SRow label="媒体缓存" hint={cache.data !== null ? `${cache.data.media.count} 个文件 · ${mb(cache.data.media.bytes)}` : '读取中'} />
        <SRow
          label="清理缓存"
          onClick={() => {
            void api
              .clearCache('all')
              .then(() => {
                setNote('缓存已清理');
                cache.reload();
              })
              .catch((err: unknown) => setNote(`清理失败：${(err as Error).message}`));
          }}
          right={<span className="ms-pill">清理</span>}
        />
        <SRow label="下载管理" onClick={() => go('downloads')} />
      </div>

      <h3 className="ms-title">更多</h3>
      <div className="ms-card">
        <SRow label="服务地址" hint={window.HorunAndroid?.getServerUrl() ?? location.origin} />
        {window.HorunAndroid !== undefined && <SRow label="切换电脑" onClick={() => window.HorunAndroid?.openSetup()} />}
        <SRow label="关于 HorunDrama 手机端" onClick={() => go('about')} />
        <SRow label="新剧日历" onClick={() => go('new')} />
        <SRow label="分类筛选" onClick={() => go('category')} />
      </div>

      {(note !== '' || busy) && <p className="ms-note">{busy ? '处理中…' : note}</p>}
      <p className="ms-foot">手机只负责显示和操作，解码、下载、签名都在电脑上跑。</p>

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
