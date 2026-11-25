/**
 * 打赏弹窗：微信 / 支付宝收款码 + 联系方式。
 *
 * 图片放在 `public/reward/` 下（不打包进 JS，静态资源直接引用）：
 *   - wechat.jpg  微信收款码
 *   - alipay.jpg  支付宝收款码
 */
import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { useApp } from '../store.ts';
import { APP_AUTHOR } from '../app-info.ts';

interface Channel {
  key: 'wechat' | 'alipay';
  name: string;
  hint: string;
  image: string;
  tone: string;
}

const CHANNELS: Channel[] = [
  {
    key: 'wechat',
    name: '微信',
    hint: '微信扫一扫，赞助一杯奶茶',
    image: '/reward/wechat.jpg',
    tone: '#07c160',
  },
  {
    key: 'alipay',
    name: '支付宝',
    hint: '支付宝扫一扫，支持持续更新',
    image: '/reward/alipay.jpg',
    tone: '#1677ff',
  },
];

const CONTACTS: Array<{ label: string; value: string }> = [
  { label: '邮箱', value: 'hoppetthappy@gmail.com' },
  { label: 'QQ', value: '758269701' },
];

export function RewardDialog(): JSX.Element | null {
  const open = useApp((s) => s.rewardOpen);
  const closeReward = useApp((s) => s.closeReward);
  const [active, setActive] = useState<Channel['key']>('wechat');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeReward();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeReward]);

  if (!open) return null;

  const channel = CHANNELS.find((c) => c.key === active) ?? CHANNELS[0]!;

  const copy = (value: string, label: string): void => {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(label);
        window.setTimeout(() => setCopied(''), 1800);
      })
      .catch(() => undefined);
  };

  return (
    <div className="reward" role="dialog" aria-modal="true" aria-label="打赏支持">
      <button className="reward__mask" aria-label="关闭" onClick={closeReward} />
      <div className="reward__card">
        <header className="reward__head">
          <div>
            <h2 className="reward__title">打赏支持</h2>
            <p className="reward__sub">
              作者 {APP_AUTHOR} · 这个小客户端是个人业余维护的，一杯奶茶就能让它多活一阵子
            </p>
          </div>
          <button className="reward__close" onClick={closeReward} aria-label="关闭">
            ✕
          </button>
        </header>

        <div className="reward__tabs" role="tablist">
          {CHANNELS.map((item) => (
            <button
              key={item.key}
              role="tab"
              aria-selected={item.key === active}
              className="reward__tab"
              data-active={item.key === active}
              style={{ ['--tone' as string]: item.tone }}
              onClick={() => setActive(item.key)}
            >
              <span className="reward__dot" />
              {item.name}
            </button>
          ))}
        </div>

        <figure className="reward__figure">
          <img className="reward__qr" src={channel.image} alt={`${channel.name}收款码`} />
          <figcaption className="reward__caption">{channel.hint}</figcaption>
        </figure>

        <div className="reward__contact">
          <p className="reward__contact-title">联系作者 {APP_AUTHOR}</p>
          <div className="reward__contact-rows">
            {CONTACTS.map((row) => (
              <button
                key={row.label}
                className="reward__contact-row"
                title={`复制${row.label}`}
                onClick={() => copy(row.value, row.label)}
              >
                <span className="reward__contact-label">{row.label}</span>
                <span className="reward__contact-value">{row.value}</span>
                <span className="reward__contact-copy">{copied === row.label ? '已复制' : '复制'}</span>
              </button>
            ))}
          </div>
        </div>

        <p className="reward__foot">打赏纯属自愿，不影响任何功能使用。</p>
      </div>
    </div>
  );
}
