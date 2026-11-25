import { useEffect, useRef, useState } from 'react';
import type { JSX, MouseEvent } from 'react';
import { api, type Settings as SettingsData } from '../../api.ts';
import { useAsync } from '../../hooks/useAsync.ts';
import { useNav } from '../nav.tsx';
import { Group, Icon, Row, Segmented, Sheet, Switch } from '../ui.tsx';
import { useApp, type Accent } from '../../store.ts';

const ACCENTS: Array<{ value: Accent; label: string; color: string }> = [
  { value: 'ember', label: '暖橙', color: '#ff4d2e' },
  { value: 'jade', label: '青玉', color: '#2fbf9b' },
  { value: 'violet', label: '暮紫', color: '#8b5cf6' },
  { value: 'azure', label: '远蓝', color: '#3b82f6' },
];

function mb(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function Me(): JSX.Element {
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
  /** 「设置」快捷卡滚到这里（播放 + 外观两组，阶段 A 不做独立设置页） */
  const settingsRef = useRef<HTMLDivElement | null>(null);

  // 手机号登录
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [smsCodeKey, setSmsCodeKey] = useState('');
  const [smsMfa, setSmsMfa] = useState(false);
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    void refreshAccount();
  }, [refreshAccount]);

  useEffect(() => {
    if (settings.data !== null) setDraft(settings.data);
  }, [settings.data]);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setTimeout(() => setCountdown((n) => n - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  const patch = (next: Partial<SettingsData>): void => {
    setDraft((prev) => ({ ...(prev ?? (settings.data as SettingsData)), ...next }));
    void api
      .saveSettings(next)
      .then(() => settings.reload())
      .catch((err: unknown) => setNote(`保存失败：${(err as Error).message}`));
  };

  const sendCode = async (): Promise<void> => {
    setBusy(true);
    setNote('正在发送验证码…');
    try {
      const res = await api.accountSendCode(phone);
      setNote(res.message);
      if (res.ok) {
        setCountdown(60);
        if (res.smsCodeKey !== undefined) setSmsCodeKey(res.smsCodeKey);
        setCode('');
        setSmsMfa(false);
      }
    } catch (err) {
      setNote(`发送失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const login = async (): Promise<void> => {
    setBusy(true);
    setNote('登录中…');
    try {
      const res = await api.accountLoginSms(phone, code, smsCodeKey);
      setNote(res.message);
      if (res.ok) {
        setCode('');
        setSmsMfa(false);
        await refreshAccount();
        setLoginOpen(false);
      } else if (res.code === 2046) {
        setSmsMfa(true);
      }
    } catch (err) {
      setNote(`登录失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const continueSms = async (): Promise<void> => {
    setBusy(true);
    setNote('正在验证上行短信…');
    try {
      const res = await api.accountContinueSms(phone, code);
      setNote(res.message);
      if (res.ok) {
        await refreshAccount();
        setLoginOpen(false);
      }
    } catch (err) {
      setNote(`验证失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
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

  /**
   * 深色/浅色切换：支持 View Transition 的浏览器里，新主题从开关位置圆形扩散；
   * 不支持就退回瞬间切换（老 WebView 也不会报错）。
   */
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
        /* View Transition 被系统打断时不影响主题已经切过去的事实 */
      });
  };

  const data = draft ?? settings.data;
  const speed = data?.defaultSpeed ?? 1;

  return (
    <>
      <button type="button" className="m-profile" onClick={() => (account?.loggedIn === true ? void refreshAccount() : setLoginOpen(true))}>
        {account?.loggedIn === true && account.avatar !== '' ? (
          <img className="m-profile__avatar" src={account.avatar} alt="" />
        ) : (
          <span className="m-profile__avatar m-profile__avatar--empty">
            <Icon name="me" size={24} />
          </span>
        )}
        <span className="m-profile__main">
          <span className="m-profile__name">{account?.loggedIn === true ? account.nickname || '已登录' : '未登录'}</span>
          <span className="m-profile__hint">
            {account?.loggedIn === true ? '点一下同步账号数据' : '登录后收藏、进度跟账号同步'}
          </span>
        </span>
        <span className="m-profile__chev">
          <Icon name="chevron" size={18} />
        </span>
      </button>

      {/* 快捷卡（阶段 A）：下载 / 收藏 / 追更 / 设置 */}
      <div className="m-me-cards">
        <button type="button" className="m-me-card" onClick={() => go('downloads')}>
          <Icon name="download" size={19} />
          <span>下载</span>
        </button>
        <button type="button" className="m-me-card" onClick={() => go('library')}>
          <Icon name="heart" size={19} />
          <span>收藏</span>
        </button>
        <button type="button" className="m-me-card" onClick={() => go('library')}>
          <Icon name="bookmark" size={19} />
          <span>追更</span>
        </button>
        <button
          type="button"
          className="m-me-card"
          onClick={() => settingsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        >
          <Icon name="settings" size={19} />
          <span>设置</span>
        </button>
      </div>

      {account?.loggedIn === true ? (
        <Group title="账号">
          <Row
            label="同步账号数据"
            hint="收藏 / 历史 / 追更 / 预约"
            right={<Icon name="refresh" size={16} />}
            onClick={() => {
              void api
                .accountSync(true)
                .then((r) => setNote(r.message))
                .catch((err: unknown) => setNote(`同步失败：${(err as Error).message}`));
            }}
          />
          <Row label="退出登录" onClick={() => void logout()} right={<span className="m-row__danger">退出</span>} />
        </Group>
      ) : (
        <Group title="账号">
          <Row label="手机号登录" hint="本机不需要密码" right={<span className="m-btn m-btn--mini m-btn--primary">登录</span>} onClick={() => setLoginOpen(true)} />
        </Group>
      )}

      {/* 「设置」快捷卡的落点：播放 + 外观两组从这里开始 */}
      <div ref={settingsRef} />

      <Group title="播放">
        <Row
          label="自动播放下一集"
          hint="一集播完直接进入下一集"
          right={<Switch on={data?.autoPlayNext !== false} onChange={(v) => patch({ autoPlayNext: v })} />}
        />
        <Row label="默认倍速" hint={`当前 ${speed === 1 ? '1×' : `${speed}×`}`} />
        <div className="m-row m-row--stack">
          <Segmented
            items={[
              { value: '0.75', label: '0.75×' },
              { value: '1', label: '1×' },
              { value: '1.25', label: '1.25×' },
              { value: '1.5', label: '1.5×' },
              { value: '2', label: '2×' },
            ]}
            value={String(speed)}
            onChange={(v) => patch({ defaultSpeed: Number(v) })}
          />
        </div>
        <Row
          label="新集提醒"
          hint="在追剧页给有新集的剧打标"
          right={<Switch on={data?.notifyNewEpisodes !== false} onChange={(v) => patch({ notifyNewEpisodes: v })} />}
        />
      </Group>

      <Group title="外观">
        <Row label="深色玻璃" hint={theme === 'dark' ? '当前：深色' : '当前：浅色'} right={<Switch on={theme === 'dark'} onChange={(next, event) => switchTheme(next, event)} />} />
        <div className="m-row m-row--stack">
          <span className="m-row__label">主题色</span>
          <div className="m-swatches">
            {ACCENTS.map((item) => (
              <button
                key={item.value}
                type="button"
                className="m-swatch"
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
      </Group>

      <Group title="电脑连接">
        <Row
          label="服务地址"
          hint={window.HorunAndroid?.getServerUrl() ?? location.origin}
          right={
            window.HorunAndroid === undefined ? undefined : (
              <button className="m-btn m-btn--mini" type="button" onClick={() => window.HorunAndroid?.openSetup()}>
                切换
              </button>
            )
          }
        />
        <div className="m-note">手机只负责显示和操作，解码、下载、签名都在电脑上跑。电脑关机或退出核心，这部手机就连不上。</div>
      </Group>

      <Group title="存储">
        <Row label="媒体缓存" hint={cache.data !== null ? `${cache.data.media.count} 个文件 · ${mb(cache.data.media.bytes)}` : '读取中'} />
        <Row
          label="清理缓存"
          right={<span className="m-btn m-btn--mini">清理</span>}
          onClick={() => {
            void api
              .clearCache('all')
              .then(() => {
                setNote('缓存已清理');
                cache.reload();
              })
              .catch((err: unknown) => setNote(`清理失败：${(err as Error).message}`));
          }}
        />
        <Row label="下载管理" chevron onClick={() => go('downloads')} />
      </Group>

      <Group title="更多">
        <Row label="关于 HorunDrama 手机端" chevron onClick={() => go('about')} />
        <Row label="新剧日历" chevron onClick={() => go('new')} />
        <Row label="分类筛选" chevron onClick={() => go('category')} />
      </Group>

      {(note !== '' || busy) && <div className="m-note m-note--live">{busy ? '处理中…' : note}</div>}

      <p className="m-foot">本地测试版 · 数据都在你自己的电脑上</p>

      <Sheet open={loginOpen} onClose={() => setLoginOpen(false)} title="手机号登录">
        <div className="m-form">
          <input
            className="m-input"
            inputMode="numeric"
            maxLength={11}
            placeholder="手机号"
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
          />
          <div className="m-form__row">
            <input
              className="m-input"
              inputMode="numeric"
              maxLength={8}
              placeholder="验证码"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
            />
            <button className="m-btn" type="button" disabled={busy || countdown > 0 || phone.length !== 11} onClick={() => void sendCode()}>
              {countdown > 0 ? `${countdown}s` : '获取'}
            </button>
          </div>
          {smsMfa && (
            <button className="m-btn" type="button" disabled={busy} onClick={() => void continueSms()}>
              我已发送上行短信
            </button>
          )}
          <button className="m-btn m-btn--primary m-btn--block" type="button" disabled={busy || phone.length !== 11 || code === ''} onClick={() => void login()}>
            登录
          </button>
          {note !== '' && <p className="m-form__note">{note}</p>}
        </div>
      </Sheet>
    </>
  );
}

