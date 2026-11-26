import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { api } from '../api.ts';
import { useApp } from '../store.ts';
import { Sheet } from './ui.tsx';

/** 手机号 + 短信验证码登录：与 PC 端同一组 /api/account/login/* 接口。 */
export function LoginSheet({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
}): JSX.Element {
  const refreshAccount = useApp((s) => s.refreshAccount);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [smsCodeKey, setSmsCodeKey] = useState('');
  const [smsMfa, setSmsMfa] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setTimeout(() => setCountdown((n) => n - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  useEffect(() => {
    if (!open) {
      setCode('');
      setSmsMfa(false);
    }
  }, [open]);

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
        onDone?.();
        onClose();
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
        onDone?.();
        onClose();
      }
    } catch (err) {
      setNote(`验证失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="手机号登录">
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
        <p className="m-form__note">手机号登录；验证码、登录态都在本机完成，不经过第三方页面。</p>
      </div>
    </Sheet>
  );
}
