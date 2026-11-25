import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { api, pingCore, type Health } from '../api.ts';
import { FEEDBACK_URL, copyToClipboard, openExternalUrl } from '../app-info.ts';
import { useApp } from '../store.ts';
import { WindowControls } from './WindowControls.tsx';
import { IconMoon, IconSearch, IconShare, IconSun } from './icons.tsx';

export function TopBar(): JSX.Element {
  const theme = useApp((s) => s.theme);
  const toggleTheme = useApp((s) => s.toggleTheme);
  const setCoreOk = useApp((s) => s.setCoreOk);
  const [health, setHealth] = useState<Health | null>(null);
  const account = useApp((s) => s.account);
  const openLogin = useApp((s) => s.openLogin);
  const setView = useApp((s) => s.setView);
  const openDetail = useApp((s) => s.openDetail);
  const openShare = useApp((s) => s.openShare);
  const updateInfo = useApp((s) => s.updateInfo);
  const openUpdateCard = useApp((s) => s.openUpdateCard);
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Array<{ text: string; keyword?: string }>>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [toast, setToast] = useState('');
  const toastTimer = useRef<number | null>(null);
  const suggestTimer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    void pingCore().then((h) => {
      if (!alive) return;
      setHealth(h);
      setCoreOk(h !== null);
    });
    return () => {
      alive = false;
    };
  }, [setCoreOk]);

  /** 顶栏短提示（反馈/外链失败时不让用户觉得"点了没反应"）。 */
  const showToast = (text: string): void => {
    setToast(text);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2600);
  };

  const runSearch = (value: string): void => {
    const q = value.trim();
    if (q === '') return;
    localStorage.setItem('horun-search-query', q);
    setQuery(q);
    setSuggestOpen(false);
    setView('search');
  };

  /** 反馈：外链 + 复制链接双保险，并给一个可见反馈。 */
  const openFeedback = (): void => {
    void copyToClipboard(FEEDBACK_URL);
    showToast('正在打开反馈页；链接已复制，若没弹出可直接粘贴到浏览器');
    void openExternalUrl(FEEDBACK_URL).then((ok) => {
      if (!ok) showToast('浏览器没打开，反馈链接已复制到剪贴板');
    });
  };

  const changeQuery = (value: string): void => {
    setQuery(value);
    if (suggestTimer.current !== null) window.clearTimeout(suggestTimer.current);
    if (value.trim() === '') {
      setSuggestions([]);
      setSuggestOpen(false);
      return;
    }
    suggestTimer.current = window.setTimeout(() => {
      void api
        .suggest(value.trim())
        .then((rows) => {
          setSuggestions(rows);
          setSuggestOpen(rows.length > 0);
        })
        .catch(() => {
          setSuggestions([]);
          setSuggestOpen(false);
        });
    }, 180);
  };

  return (
    <header className="topbar">
      <div className="brand" title="HorunDrama">
        <img className="brand__mark" src="/icon.png" alt="" width={30} height={30} />
        <span className="brand__name">HorunDrama</span>
      </div>

      <div className="search-wrap">
        <label className="search">
          <IconSearch size={17} />
          <input
            type="search"
            placeholder="搜剧名 / 演员 / 关键词"
            aria-label="搜索"
            value={query}
            onChange={(e) => changeQuery(e.target.value)}
            onFocus={() => {
              if (suggestions.length > 0) setSuggestOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch(query);
              if (e.key === 'Escape') setSuggestOpen(false);
            }}
          />
        </label>
        {suggestOpen && (
          <div className="search-suggest" role="listbox">
            {suggestions.map((row) => (
              <button
                key={`${row.text}-${row.keyword ?? ''}`}
                className="search-suggest__item"
                type="button"
                onClick={() => {
                  const id = row.keyword ?? '';
                  if (/^\d{6,25}$/.test(id)) {
                    setQuery(row.text);
                    setSuggestOpen(false);
                    openDetail(id);
                  } else {
                    runSearch(row.text);
                  }
                }}
              >
                <IconSearch size={14} />
                <span>{row.text}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="topbar__actions">
        {/* 手机端：长搜索框收成图标，点了进搜索页 */}
        <button
          className="btn btn--ghost btn--icon topbar__mobile-search"
          title="搜索"
          aria-label="搜索"
          onClick={() => setView('search')}
        >
          <IconSearch size={18} />
        </button>
        <button
          className="btn btn--ghost btn--icon topbar__feedback"
          title="反馈（GitHub Issues）"
          aria-label="反馈"
          onClick={openFeedback}
        >
          <span className="topbar__glyph">✎</span>
        </button>
        <button
          className="btn btn--ghost btn--icon topbar__share"
          title="分享续播"
          aria-label="分享续播"
          onClick={openShare}
        >
          <IconShare size={18} />
        </button>
        <button
          className="btn btn--ghost btn--icon"
          onClick={toggleTheme}
          title={theme === 'dark' ? '切到浅色' : '切到深色'}
          aria-label="切换主题"
        >
          {theme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
        </button>
        {updateInfo !== null && (
          <button
            className="topbar__update"
            title={`发现新版本 v${updateInfo.latest}，点击查看更新`}
            onClick={openUpdateCard}
          >
            <span aria-hidden="true">↑</span>
            新版本
          </button>
        )}
        <span
          className="core-dot"
          data-state={account?.loggedIn === true ? 'ok' : 'idle'}
          title={
            account?.loggedIn === true
              ? `已登录：${account.nickname || account.userId}`
              : health === null
                ? '未登录 · 本地核心未连接'
                : '未登录'
          }
        />
        {account?.loggedIn === true ? (
          <button className="account-chip" title={account.nickname || account.userId} onClick={() => setView('settings')}>
            {account.avatar !== '' ? (
              <img className="account-chip__avatar" src={account.avatar} alt="" />
            ) : (
              <span className="account-chip__avatar account-chip__avatar--empty" />
            )}
            <span className="account-chip__name">{account.nickname || '已登录'}</span>
          </button>
        ) : (
          <button className="btn btn--primary" title="登录" onClick={openLogin}>
            登录
          </button>
        )}
        <WindowControls />
      </div>
      {toast !== '' && <div className="topbar__toast">{toast}</div>}
    </header>
  );
}
