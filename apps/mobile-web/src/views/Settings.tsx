import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { api, pingCore, type CacheStats, type Health, type Settings as SettingsData } from '../api.ts';
import { Page } from '../ui/Page.tsx';
import { Select } from '../ui/Select.tsx';
import { useAsync } from '../hooks/useAsync.ts';
import { useApp, type Accent } from '../store.ts';
import {
  APP_AUTHOR,
  APP_VERSION,
  FEEDBACK_URL,
  GITHUB_REPO,
  GITHUB_URL,
  RELEASES_URL,
  checkUpdate,
  compareVersion,
  copyToClipboard,
  openExternalUrl,
} from '../app-info.ts';
import {
  COVERAGE_OPTIONS,
  SIZE_OPTIONS,
  danmakuFontSize,
  readDanmakuPrefs,
  writeDanmakuPrefs,
  type DanmakuPrefs,
} from '../settings/danmaku.ts';

function mb(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const ACCENTS: Array<{ value: Accent; label: string; color: string }> = [
  { value: 'ember', label: '暖橙', color: '#ff4d2e' },
  { value: 'jade', label: '青玉', color: '#2fbf9b' },
  { value: 'violet', label: '暮紫', color: '#8b5cf6' },
  { value: 'azure', label: '远蓝', color: '#3b82f6' },
];

export function Settings(): JSX.Element {
  const theme = useApp((s) => s.theme);
  const toggleTheme = useApp((s) => s.toggleTheme);
  const openReward = useApp((s) => s.openReward);
  const accent = useApp((s) => s.accent);
  const setAccent = useApp((s) => s.setAccent);
  const settings = useAsync((signal) => api.settings(signal), []);
  const cache = useAsync((signal) => api.cacheStats(signal), []);
  const account = useAsync((signal) => api.accountStatus(signal), []);

  const [draft, setDraft] = useState<SettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [danmaku, setDanmaku] = useState<DanmakuPrefs>(() => readDanmakuPrefs());
  const [accountNote, setAccountNote] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [smsCodeKey, setSmsCodeKey] = useState('');
  const [smsMfa, setSmsMfa] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [health, setHealth] = useState<Health | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateNote, setUpdateNote] = useState('');
  const [updateTone, setUpdateTone] = useState<'info' | 'ok' | 'warn'>('info');

  const doCheckUpdate = async (): Promise<void> => {
    setUpdateBusy(true);
    setUpdateNote('');
    try {
      const info = await checkUpdate();
      if (info.latest === '') throw new Error('还没有发布过 release');
      if (compareVersion(info.latest, APP_VERSION) > 0) {
        setUpdateTone('warn');
        setUpdateNote(
          `有新版本 v${info.latest}${info.publishedAt === '' ? '' : `（${info.publishedAt.slice(0, 10)} 发布）`}：点上面的 GitHub Releases 下载`,
        );
      } else {
        setUpdateTone('ok');
        setUpdateNote(`已是最新版本（v${APP_VERSION}）`);
      }
    } catch (err) {
      const msg = (err as Error).message;
      setUpdateTone('warn');
      setUpdateNote(
        msg.includes('还没有发布')
          ? '仓库还没有发布版本，先看上面的 GitHub Releases'
          : `检查更新失败：${msg}（也可以直接去 GitHub Releases 看）`,
      );
    } finally {
      setUpdateBusy(false);
    }
  };

  useEffect(() => {
    void pingCore()
      .then((h) => setHealth(h))
      .catch(() => undefined);
  }, []);

  const patchDanmaku = (patch: Partial<DanmakuPrefs>): void => {
    setDanmaku(writeDanmakuPrefs(patch));
  };

  const doSyncAccount = async (): Promise<void> => {
    setBusy(true);
    setAccountNote('正在同步账号数据…');
    try {
      const res = await api.accountSync(true);
      setAccountNote(res.message);
    } catch (err) {
      setAccountNote(`同步失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const doVerify = async (): Promise<void> => {
    setBusy(true);
    setAccountNote('校验中…');
    try {
      const res = await api.accountVerify();
      setAccountNote(res.ok ? '会话有效' : `校验未通过：${res.message}`);
      account.reload();
    } catch (err) {
      setAccountNote(`校验失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const doLogout = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.accountLogout();
      // 退出后立即清掉前端账号态，避免头像/昵称残留
      useApp.getState().setAccount(null);
      setPhone('');
      setCode('');
      setSmsCodeKey('');
      setAccountNote('已退出登录，登录信息已清除');
      account.reload();
    } catch (err) {
      setAccountNote(`退出失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };



  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setTimeout(() => setCountdown((n) => n - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  const doSendCode = async (): Promise<void> => {
    setBusy(true);
    setAccountNote('正在发送验证码…');
    try {
      const res = await api.accountSendCode(phone);
      setAccountNote(res.message);
      if (res.ok) {
        setCountdown(60);
        if (res.smsCodeKey !== undefined) setSmsCodeKey(res.smsCodeKey);
        // 需要上行短信时，发完短信后重新获取验证码；旧码一律作废
        setCode('');
        setSmsMfa(false);
      }
    } catch (err) {
      setAccountNote(`发送失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const doLoginSms = async (): Promise<void> => {
    setBusy(true);
    setAccountNote('登录中…');
    try {
      const res = await api.accountLoginSms(phone, code, smsCodeKey);
      setAccountNote(res.message);
      if (res.ok) {
        setCode('');
        setSmsMfa(false);
        account.reload();
      } else if (res.code === 2046) {
        // MFA 上下文绑定原验证码；不能重新获取验证码
        setSmsMfa(true);
      }
    } catch (err) {
      setAccountNote(`登录失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const doContinueSms = async (): Promise<void> => {
    setBusy(true);
    setAccountNote('正在验证上行短信…');
    try {
      const res = await api.accountContinueSms(phone, code);
      setAccountNote(res.message);
      if (res.ok) {
        setCode('');
        setSmsMfa(false);
        account.reload();
      }
    } catch (err) {
      setAccountNote(`验证失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (settings.data !== null) setDraft(settings.data);
  }, [settings.data]);

  const pickDir = async (kind: 'mediaCacheDir' | 'downloadDir'): Promise<void> => {
    const bridge = window.yimu;
    if (bridge?.pickDirectory === undefined) {
      setNote('浏览器里没有目录选择器，请在桌面端修改');
      return;
    }
    const res = await bridge.pickDirectory(draft?.[kind] ?? '');
    if (res.ok && res.path !== undefined) {
      setDraft((d) => (d === null ? d : { ...d, [kind]: res.path ?? '' }));
    }
  };

  const save = async (): Promise<void> => {
    if (draft === null) return;
    setSaving(true);
    setNote('');
    try {
      const next = await api.saveSettings(draft);
      setDraft(next);
      cache.reload();
      setNote('已保存');
    } catch (err) {
      setNote(`保存失败：${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const clear = async (target: 'all' | 'media' | 'images'): Promise<void> => {
    setBusy(true);
    setNote('');
    try {
      const res = await api.clearCache(target);
      cache.reload();
      setNote(`已清理：视频 ${res.media.removed} 个 / 图片 ${res.images.removed} 个`);
    } catch (err) {
      setNote(`清理失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const stats: CacheStats | null = cache.data;

  return (
    <Page title="我的" sub="账号 · 播放 · 电脑连接 · 关于" narrow>
      <section className="settings-block">
        <h2 className="settings-block__title">账号</h2>

        {account.data === null ? (
          <p className="settings-hint">账号状态读取中…</p>
        ) : account.data.loggedIn ? (
          <>
            <div className="settings-row">
              <div className="settings-row__grow">
                <div className="account-card">
                  {account.data.avatar !== '' && <img className="account-card__avatar" src={account.data.avatar} alt="" />}
                  <div>
                    <p className="settings-label">{account.data.nickname || '已登录'}</p>
                    <p className="settings-hint">
                      userId {account.data.userId} · Cookie {account.data.cookieCount} 条 · 来源 {account.data.source}
                    </p>
                  </div>
                </div>
              </div>
              <button className="btn" disabled={busy} onClick={() => void doSyncAccount()}>
                同步数据
              </button>
              <button className="btn" disabled={busy} onClick={() => void doVerify()}>
                校验
              </button>
              <button className="btn btn--ghost" disabled={busy} onClick={() => void doLogout()}>
                退出
              </button>
            </div>
            <p className="settings-hint">
              账号设备 {account.data.deviceId || '(无)'}
              {account.data.signerAvailable ? ' · 签名服务在线' : ' · 签名服务未启动'}
            </p>
            <p className="settings-hint">
              写回账号：收藏 / 点赞 / 预约 / 观看进度 · 追更仅本机（上游没有追更写接口）
            </p>
          </>
        ) : (
          <>
            <div className="settings-row account-hero">
              <span className="account-card__avatar account-card__avatar--empty" aria-hidden="true" />
              <div className="settings-row__grow">
                <p className="settings-label">未登录</p>
                <p className="settings-hint">
                  收藏与进度当前只存在本机。可用手机号 + 验证码登录。
                </p>
              </div>

            </div>
            <div className="sms-form">
              <input
                className="settings-input sms-form__phone"
                inputMode="numeric"
                maxLength={11}
                placeholder="手机号"
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
              />
              <button className="btn" disabled={busy || countdown > 0 || phone.length !== 11} onClick={() => void doSendCode()}>
                {countdown > 0 ? `${countdown}s` : '发送验证码'}
              </button>
              <input
                className="settings-input sms-form__code"
                inputMode="numeric"
                maxLength={8}
                placeholder="验证码"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
              />
              <button
                className="btn btn--primary"
                disabled={busy || phone.length !== 11 || code.length < 4}
                onClick={() => void doLoginSms()}
              >
                登录
              </button>
            </div>
            {smsMfa && (
              <button
                className="btn"
                disabled={busy || code.length < 4}
                onClick={() => void doContinueSms()}
              >
                我已发送短信，继续验证
              </button>
            )}
            <p className="settings-hint">
              签名服务 {account.data.signerAvailable ? '在线' : '未启动（账号接口需要它）'} ·
              手机号按官方接口要求编码后提交
            </p>
          </>
        )}

        {accountNote !== '' && <p className="settings-note">{accountNote}</p>}
      </section>

      {window.HorunAndroid !== undefined && (
        <section className="settings-block">
          <h2 className="settings-block__title">电脑连接</h2>
          <div className="settings-row">
            <div className="settings-row__grow">
              <p className="settings-label">服务地址</p>
              <p className="settings-hint">{window.HorunAndroid.getServerUrl()}</p>
            </div>
            <button className="btn" onClick={() => window.HorunAndroid?.openSetup()}>
              修改
            </button>
          </div>
          <p className="settings-hint">
            播放、转码、下载、账号都在电脑上执行，手机只是遥控器加播放屏。换了 Wi-Fi 或电脑 IP 变了，点「修改」重填地址。
          </p>
        </section>
      )}

      <section className="settings-block">
        <h2 className="settings-block__title">外观</h2>
        <div className="settings-row">
          <div>
            <p className="settings-label">主题</p>
            <p className="settings-hint">当前：{theme === 'dark' ? '深色玻璃' : '浅色玻璃'}</p>
          </div>
          <button className="btn" onClick={toggleTheme}>
            切到{theme === 'dark' ? '浅色' : '深色'}
          </button>
        </div>

        <div className="settings-row">
          <div className="settings-row__grow">
            <p className="settings-label">主题色</p>
            <p className="settings-hint">暖橙 / 青玉 / 暮紫 / 远蓝，按钮、导航和强调色一起变</p>
          </div>
          <div className="accent-swatches">
            {ACCENTS.map((item) => (
              <button
                key={item.value}
                className="accent-swatch"
                style={{ ['--swatch' as string]: item.color }}
                data-active={accent === item.value}
                title={item.label}
                aria-label={`主题色：${item.label}`}
                onClick={() => setAccent(item.value)}
              />
            ))}
          </div>
        </div>
      </section>

      <section className="settings-block">
        <h2 className="settings-block__title">播放</h2>

        <div className="settings-row">
          <div className="settings-row__grow">
            <p className="settings-label">自动播放下一集</p>
            <p className="settings-hint">一集播完自动进入下一集，追剧时不用手动点</p>
          </div>
          <button
            className={`btn${draft?.autoPlayNext === true ? ' btn--primary' : ''}`}
            onClick={() =>
              setDraft((d) => (d === null ? d : { ...d, autoPlayNext: !(d.autoPlayNext === true) }))
            }
          >
            {draft?.autoPlayNext === true ? '已开启' : '已关闭'}
          </button>
        </div>

        <div className="settings-row">
          <div className="settings-row__grow">
            <p className="settings-label">默认倍速</p>
            <p className="settings-hint">播放页控制条的倍速按钮以它为起点</p>
          </div>
          <Select
            value={String(draft?.defaultSpeed ?? 1)}
            ariaLabel="默认倍速"
            options={[0.75, 1, 1.25, 1.5, 2].map((n) => ({ value: String(n), label: `${n}×` }))}
            onChange={(value) => {
              const speed = Number(value);
              setDraft((d) => (d === null ? d : { ...d, defaultSpeed: speed }));
            }}
          />
        </div>

        <div className="settings-row">
          <div className="settings-row__grow">
            <p className="settings-label">跳过片头</p>
            <p className="settings-hint">只在这一集从头播时生效；续播优先回到上次位置</p>
          </div>
          <Select
            value={String(draft?.skipIntroSec ?? 0)}
            ariaLabel="跳过片头"
            options={[0, 5, 10, 15, 30].map((n) => ({
              value: String(n),
              label: n === 0 ? '不跳' : `${n} 秒`,
            }))}
            onChange={(value) => {
              const sec = Number(value);
              setDraft((d) => (d === null ? d : { ...d, skipIntroSec: sec }));
            }}
          />
        </div>

        <div className="settings-row">
          <div className="settings-row__grow">
            <p className="settings-label">跳过片尾</p>
            <p className="settings-hint">片尾前这么多秒直接进下一集；只在「自动播放下一集」开启时生效</p>
          </div>
          <Select
            value={String(draft?.skipOutroSec ?? 0)}
            ariaLabel="跳过片尾"
            options={[0, 5, 10, 15, 30].map((n) => ({
              value: String(n),
              label: n === 0 ? '不跳' : `${n} 秒`,
            }))}
            onChange={(value) => {
              const sec = Number(value);
              setDraft((d) => (d === null ? d : { ...d, skipOutroSec: sec }));
            }}
          />
        </div>
      </section>

      <section className="settings-block">
        <h2 className="settings-block__title">通知与更新提醒</h2>

        <div className="settings-row">
          <div className="settings-row__grow">
            <p className="settings-label">新集提醒（应用内）</p>
            <p className="settings-hint">在追剧页给有新集的剧打「有新集」标记；只做应用内提醒，不弹系统通知</p>
          </div>
          <button
            className={`btn${draft?.notifyNewEpisodes !== false ? ' btn--primary' : ''}`}
            onClick={() =>
              setDraft((d) =>
                d === null ? d : { ...d, notifyNewEpisodes: !(d.notifyNewEpisodes !== false) },
              )
            }
          >
            {draft?.notifyNewEpisodes !== false ? '已开启' : '已关闭'}
          </button>
        </div>

        <div className="settings-row">
          <div className="settings-row__grow">
            <p className="settings-label">自动同步账号</p>
            <p className="settings-hint">打开追剧页时拉账号的收藏/历史/追更/预约；关闭后只能点「同步账号」</p>
          </div>
          <button
            className={`btn${draft?.autoSyncAccount !== false ? ' btn--primary' : ''}`}
            onClick={() =>
              setDraft((d) => (d === null ? d : { ...d, autoSyncAccount: !(d.autoSyncAccount !== false) }))
            }
          >
            {draft?.autoSyncAccount !== false ? '已开启' : '已关闭'}
          </button>
        </div>
      </section>

      <section className="settings-block">
        <h2 className="settings-block__title">画质与下载</h2>

        <div className="settings-row">
          <div className="settings-row__grow">
            <p className="settings-label">默认清晰度</p>
            <p className="settings-hint">
              自动 = 先秒开（官网 360p），高清在后台转好再自动换源；直接选档位会一直等高清转码
            </p>
          </div>
          <Select
            value={draft?.defaultQuality ?? 'auto'}
            ariaLabel="默认清晰度"
            options={[
              { value: 'auto', label: '自动（秒开 + 后台升级）' },
              { value: 'smooth', label: '流畅 360p（最快）' },
              { value: '480p', label: '标清 480p' },
              { value: '720p', label: '高清 720p' },
              { value: '1080p', label: '超清 1080p' },
            ]}
            onChange={(value) => {
              const quality = value as SettingsData['defaultQuality'];
              setDraft((d) => (d === null ? d : { ...d, defaultQuality: quality }));
            }}
          />
        </div>

        <div className="settings-row">
          <div className="settings-row__grow">
            <p className="settings-label">打赏支持</p>
            <p className="settings-hint">
              微信 / 支付宝收款码，以及作者的联系方式（邮箱 hoppetthappy@gmail.com、QQ 758269701）
            </p>
          </div>
          <button className="btn" onClick={openReward}>
            打开
          </button>
        </div>

        <div className="settings-row">
          <div className="settings-row__grow">
            <p className="settings-label">预加载集数</p>
            <p className="settings-hint">
              以正在看的这集为中心，向前、向后各预加载这么多集，切集不用等（0 = 关闭；默认 5）
            </p>
          </div>
          <Select
            value={String(draft?.preloadCount ?? 5)}
            ariaLabel="预加载集数"
            options={[0, 2, 3, 5, 8, 10].map((n) => ({ value: String(n), label: n === 0 ? '关闭' : `前后各 ${n} 集` }))}
            onChange={(value) => {
              const preloadCount = Number(value);
              setDraft((d) => (d === null ? d : { ...d, preloadCount }));
            }}
          />
        </div>

        <div className="settings-row">
          <div className="settings-row__grow">
            <p className="settings-label">同时下载集数</p>
            <p className="settings-hint">转码很吃 CPU，默认 2；机器好可以调到 4</p>
          </div>
          <Select
            value={String(draft?.downloadConcurrency ?? 2)}
            ariaLabel="同时下载集数"
            options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: `${n} 集` }))}
            onChange={(value) => {
              const concurrency = Number(value);
              setDraft((d) => (d === null ? d : { ...d, downloadConcurrency: concurrency }));
            }}
          />
        </div>

        <div className="settings-row">
          <div className="settings-row__grow">
            <p className="settings-label">画质增强</p>
            <p className="settings-hint">
              转码时轻度降噪 + 锐化（hqdn3d + unsharp）；只对之后新转的集生效，已缓存的不变
            </p>
          </div>
          <Select
            value={draft?.enhanceVideo ?? 'off'}
            ariaLabel="画质增强"
            options={[
              { value: 'off', label: '关闭' },
              { value: 'standard', label: '标准（降噪 + 锐化）' },
              { value: 'strong', label: '强力' },
            ]}
            onChange={(value) => {
              const enhance = value as SettingsData['enhanceVideo'];
              setDraft((d) => (d === null ? d : { ...d, enhanceVideo: enhance }));
            }}
          />
        </div>

        <p className="settings-hint">改完点下面「保存设置」生效；播放页手动选的清晰度会覆盖这里的默认值。</p>
      </section>

      <section className="settings-block">
        <h2 className="settings-block__title">目录与缓存</h2>

        <div className="settings-row">
          <div className="settings-row__grow">
            <p className="settings-label">转码缓存目录</p>
            <p className="settings-path">{draft?.mediaCacheDir ?? '加载中…'}</p>
          </div>
          <button className="btn" onClick={() => void pickDir('mediaCacheDir')}>
            选择…
          </button>
        </div>

        <div className="settings-row">
          <div className="settings-row__grow">
            <p className="settings-label">缓存上限</p>
            <p className="settings-hint">超过后按最久未用自动清理（最小 256 MB）</p>
          </div>
          <input
            className="settings-input"
            type="number"
            min={256}
            step={256}
            value={draft?.mediaCacheMB ?? 0}
            onChange={(e) => {
              const v = Number(e.target.value);
              setDraft((d) => (d === null ? d : { ...d, mediaCacheMB: Number.isFinite(v) ? v : 0 }));
            }}
          />
          <span className="settings-unit">MB</span>
        </div>

        <div className="settings-row">
          <div className="settings-row__grow">
            <p className="settings-label">下载目录</p>
            <p className="settings-path">{draft?.downloadDir ?? '加载中…'}</p>
          </div>
          <button className="btn" onClick={() => void pickDir('downloadDir')}>
            选择…
          </button>
        </div>

        <div className="settings-row">
          <div className="settings-row__grow">
            <p className="settings-label">当前占用</p>
            <p className="settings-hint">
              视频 {stats === null ? '…' : `${stats.media.count} 个 / ${mb(stats.media.bytes)}`}
              {' · '}
              封面 {stats === null ? '…' : `${stats.images.count} 张 / ${mb(stats.images.bytes)}`}
            </p>
          </div>
          <button className="btn" disabled={busy} onClick={() => void clear('all')}>
            清空缓存
          </button>
        </div>

        <div className="settings-actions">
          <button className="btn btn--primary" disabled={saving || draft === null} onClick={() => void save()}>
            {saving ? '保存中…' : '保存设置'}
          </button>
          {note !== '' && <span className="settings-note">{note}</span>}
        </div>
      </section>

      <section className="settings-block">
        <h2 className="settings-block__title">弹幕</h2>

        <div className="settings-row">
          <div className="settings-row__grow">
            <p className="settings-label">显示弹幕</p>
            <p className="settings-hint">按播放时间取弹幕；暂停时整层冻结，恢复后继续飘</p>
          </div>
          <button
            className={`btn${danmaku.enabled ? ' btn--primary' : ''}`}
            onClick={() => patchDanmaku({ enabled: !danmaku.enabled })}
          >
            {danmaku.enabled ? '已开启' : '已关闭'}
          </button>
        </div>

        <div className="settings-row">
          <div className="settings-row__grow">
            <p className="settings-label">背景</p>
            <p className="settings-hint">默认纯透明，只靠文字描边保证可读</p>
          </div>
          <div className="settings-chips">
            <button
              className={`chip${danmaku.background === 'none' ? ' chip--on' : ''}`}
              onClick={() => patchDanmaku({ background: 'none' })}
            >
              透明
            </button>
            <button
              className={`chip${danmaku.background === 'soft' ? ' chip--on' : ''}`}
              onClick={() => patchDanmaku({ background: 'soft' })}
            >
              半透明
            </button>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row__grow">
            <p className="settings-label">占屏高度</p>
            <p className="settings-hint">弹幕只在这个高度内飘，越低越不挡画面</p>
          </div>
          <div className="settings-chips">
            {COVERAGE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`chip${danmaku.coverage === opt.value ? ' chip--on' : ''}`}
                onClick={() => patchDanmaku({ coverage: opt.value })}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row__grow">
            <p className="settings-label">字号</p>
            <div
              className="danmaku-preview"
              style={{ fontSize: `${danmakuFontSize(danmaku.size)}px` }}
            >
              <span
                className="danmaku-preview__text"
                data-bg={danmaku.background}
              >
                这条是弹幕预览
              </span>
            </div>
          </div>
          <div className="settings-chips">
            {SIZE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`chip${danmaku.size === opt.value ? ' chip--on' : ''}`}
                onClick={() => patchDanmaku({ size: opt.value })}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <p className="settings-hint">播放页里也可以按 D 或点控制条的「弹」临时开关。</p>
      </section>

      <section className="settings-block desktop-only">
        <h2 className="settings-block__title">播放快捷键</h2>
        <ul className="settings-keys">
          <li>
            <kbd>空格</kbd> 播放 / 暂停
          </li>
          <li>
            <kbd>←</kbd> <kbd>→</kbd> 后退 / 前进 5 秒
          </li>
          <li>
            <kbd>F</kbd> 全屏
          </li>
          <li>
            <kbd>Esc</kbd> 退出全屏 / 返回
          </li>
        </ul>
      </section>


      <section className="settings-block">
        <h2 className="settings-block__title">关于</h2>

        <div className="settings-row">
          <div className="settings-row__grow">
            <p className="settings-label">HorunDrama 手机端</p>
            <p className="settings-hint">Android 版 · 版本 {APP_VERSION} · 本地测试版，暂不对外发布</p>
          </div>
          <button className="btn btn--ghost" onClick={openReward}>
            打赏作者
          </button>
        </div>

        <div className="settings-row">
          <div className="settings-row__grow">
            <p className="settings-label">作者</p>
            <p className="settings-hint">
              {APP_AUTHOR} · 个人业余维护（邮箱 hoppetthappy@gmail.com，QQ 758269701）
            </p>
          </div>
        </div>

        <div className="settings-row desktop-only">
          <div className="settings-row__grow">
            <p className="settings-label">更新与源码</p>
            <p className="settings-hint">
              <a
                className="settings-link"
                href={RELEASES_URL}
                onClick={(e) => {
                  e.preventDefault();
                  openExternalUrl(RELEASES_URL);
                }}
              >
                GitHub Releases
              </a>
              {' · '}
              <a
                className="settings-link"
                href={GITHUB_URL}
                onClick={(e) => {
                  e.preventDefault();
                  openExternalUrl(GITHUB_URL);
                }}
              >
                {GITHUB_REPO}
              </a>
              {' · '}
              <a
                className="settings-link"
                href={FEEDBACK_URL}
                onClick={(e) => {
                  e.preventDefault();
                  openExternalUrl(FEEDBACK_URL);
                }}
              >
                提 issue
              </a>
            </p>
            <p className="settings-hint">
              <button
                className="settings-link settings-link--button"
                onClick={() => {
                  void copyToClipboard(RELEASES_URL).then((ok) => {
                    setUpdateTone(ok ? 'ok' : 'warn');
                    setUpdateNote(ok ? '下载链接已复制，可粘贴到浏览器打开' : '复制失败，请手动选中链接');
                  });
                }}
              >
                复制下载链接
              </button>
              {' · '}
              <button
                className="settings-link settings-link--button"
                onClick={() => {
                  void copyToClipboard(FEEDBACK_URL).then((ok) => {
                    setUpdateTone(ok ? 'ok' : 'warn');
                    setUpdateNote(ok ? '反馈链接已复制，可粘贴到浏览器打开' : '复制失败，请手动选中链接');
                  });
                }}
              >
                复制反馈链接
              </button>
            </p>
          </div>
          <button className="btn btn--ghost" disabled={updateBusy} onClick={() => void doCheckUpdate()}>
            {updateBusy ? '检查中…' : '检查更新'}
          </button>
        </div>

        {updateNote !== '' && (
          <p className="settings-hint desktop-only" data-tone={updateTone}>
            {updateNote}
          </p>
        )}

        <div className="settings-row">
          <div className="settings-row__grow">
            <p className="settings-label">电脑上的数据目录</p>
            <p className="settings-path">{health?.dataRoot ?? '读取中…'}</p>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row__grow">
            <p className="settings-label">内核</p>
            <p className="settings-hint">
              {health?.name ?? 'HorunDrama core'} v{health?.version ?? '…'} · Node {health?.node ?? '…'} · 已运行{' '}
              {health === null ? '…' : `${Math.floor(health.uptimeSec / 60)} 分钟`}
            </p>
          </div>
        </div>

        <p className="settings-hint">
          手机端只负责显示和操作，解析、转码、下载、登录都在电脑上完成，所以电脑和手机要连同一个 Wi-Fi。
          内容来自公开接口，仅供个人学习与自用，不做任何商业分发。
        </p>
      </section>
    </Page>
  );
}
