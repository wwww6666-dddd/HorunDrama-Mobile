import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { api } from '../api.ts';
import { useApp } from '../store.ts';

/**
 * 登录弹窗：手机号 + 验证码。
 *
 * 请求格式按官方客户端抓包得到的协议实现：
 * 全部参数走 form body、mobile/code 做 XOR(0x05) hex、发码带 type=3731。
 * 登录成功后会话落盘，之后所有账号能力都用这份会话。
 */
export function LoginDialog(): JSX.Element | null {
  const open = useApp((s) => s.loginOpen);
  const close = useApp((s) => s.closeLogin);
  const refreshAccount = useApp((s) => s.refreshAccount);

  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [smsCodeKey, setSmsCodeKey] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [mfa, setMfa] = useState(false);

  useEffect(() => {
    const bridge = window.yimu;
    if (bridge?.onLoginChanged === undefined) return;
    return bridge.onLoginChanged(async (payload) => {
      const ok = (payload as { loggedIn?: boolean })?.loggedIn === true;
      if (!ok) return;
      await refreshAccount();
      close();
    });
  }, [refreshAccount, close]);

  useEffect(() => {
    if (!open) return;
    setNote('');
    setCode('');
    setCountdown(0);
    setMfa(false);
  }, [open]);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setTimeout(() => setCountdown((n) => n - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  if (!open) return null;

  const sendCode = async (): Promise<void> => {
    setBusy(true);
    setNote('正在发送验证码…');
    try {
      const res = await api.accountSendCode(phone);
      setNote(res.message);
      if (res.ok) {
        setCountdown(typeof res.retryAfter === 'number' && res.retryAfter > 0 ? res.retryAfter : 60);
        if (res.smsCodeKey !== undefined) setSmsCodeKey(res.smsCodeKey);
        // 上行短信验证后必须换新码：发码成功就把旧码清掉，等待用户输入新码
        setCode('');
        setMfa(false);
      }
    } catch (err) {
      setNote(`发送失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    setNote('登录中…');
    setMfa(false);
    try {
      const res = await api.accountLoginSms(phone, code, smsCodeKey);
      setNote(res.message);
      if (res.ok) {
        await refreshAccount();
        setPhone('');
        setCode('');
        close();
      } else if (res.code === 2046) {
        setMfa(true);
        // 关键：MFA 上下文绑定触发验证时的验证码/sms_code_key，
        // 重新获取验证码会换掉上下文并导致 1203。这里必须保留原验证码。
      }
    } catch (err) {
      setNote(`登录失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // 上行短信已发送：用原验证码重跑 MFA 校验 + 重试登录
  const continueVerify = async (): Promise<void> => {
    setBusy(true);
    setNote('正在验证上行短信…');
    try {
      const res = await api.accountContinueSms(phone, code);
      setNote(res.message);
      if (res.ok) {
        await refreshAccount();
        setPhone('');
        setCode('');
        close();
      }
    } catch (err) {
      setNote(`验证失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-mask" role="presentation" onClick={close}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="登录" onClick={(e) => e.stopPropagation()}>
        <div className="dialog__head">
          <h2 className="dialog__title">手机号登录</h2>
          <button className="btn btn--ghost btn--icon" onClick={close} aria-label="关闭">
            ✕
          </button>
        </div>

        <p className="dialog__hint">
          验证码会发到你的手机。登录后本机使用该账号的收藏、观看记录与订阅数据，
          与官方 App 共用同一个账号。
        </p>

        <label className="dialog__field">
          <span>手机号</span>
          <input
            className="settings-input"
            inputMode="numeric"
            maxLength={11}
            placeholder="请输入 11 位手机号"
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
          />
        </label>

        <div className="dialog__row">
          <label className="dialog__field dialog__field--grow">
            <span>验证码</span>
            <input
              className="settings-input"
              inputMode="numeric"
              maxLength={8}
              placeholder="请输入验证码"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
            />
          </label>
          <button
            className="btn"
            disabled={busy || countdown > 0 || phone.length !== 11}
            onClick={() => void sendCode()}
          >
            {countdown > 0 ? `${countdown}s` : '获取验证码'}
          </button>
        </div>

        <button
          className="btn btn--primary dialog__submit"
          disabled={busy || phone.length !== 11 || code.length < 4}
          onClick={() => void submit()}
        >
          登录
        </button>

        {mfa && (
          <button
            className="btn dialog__submit"
            disabled={busy || code.length < 4}
            onClick={() => void continueVerify()}
          >
            我已发送短信，继续验证
          </button>
        )}

        {note !== '' && <p className="dialog__note">{note}</p>}
      </div>
    </div>
  );
}
