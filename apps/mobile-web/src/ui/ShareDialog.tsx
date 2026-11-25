/**
 * 「分享续播」弹窗。
 *
 * 两个方向：
 *  1. 复制**红果原链接**（官方参数 video_id=剧、vid=集，另挂 no/t 给本软件解析；
 *     红果网页会忽略这两个参数）；
 *  2. 粘贴别人分享的红果链接 → 解析 → 先弹一张影片卡片确认（剧名/封面/第几集/从哪开始）
 *     → 点「开始观看」才跳转，不会糊里糊涂跳走。
 */
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { api } from '../api.ts';
import { copyToClipboard } from '../app-info.ts';
import { playHash, parsePlay } from '../routes.ts';
import { useApp } from '../store.ts';
import { hongguoShareLink, parseSharedLink } from '../share.ts';

/** 解析出来的待观看目标（先给用户看一眼再跳） */
interface Preview {
  seriesId: string;
  episodeId: string;
  no: number;
  startAt: number;
  title: string;
  cover: string;
  episodeCount: number;
}

export function ShareDialog(): JSX.Element | null {
  const open = useApp((s) => s.shareOpen);
  const closeShare = useApp((s) => s.closeShare);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  /** 「当前这一集」那个只读输入框：复制被拒时用它兜底选中 */
  const linkRef = useRef<HTMLInputElement | null>(null);
  /** 当前播放页信息（在播放页打开时才能"分享这一集"） */
  const [current, setCurrent] = useState<{ seriesId: string; episodeId: string; no: number; at: number } | null>(
    null,
  );

  useEffect(() => {
    if (!open) return;
    const route = parsePlay(location.hash);
    const video = document.querySelector('video');
    const at = video !== null && Number.isFinite(video.currentTime) ? video.currentTime : 0;
    setCurrent(route === null ? null : { seriesId: route.seriesId, episodeId: route.episodeId, no: route.no, at });
    setText('');
    setNote('');
    setCopied(false);
    setPreview(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeShare();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeShare]);

  if (!open) return null;

  const copyCurrent = (): void => {
    if (current === null) return;
    const at = current.at > 3 ? current.at : 0;
    const link = hongguoShareLink(current.seriesId, current.episodeId, current.no, at);
    void copyToClipboard(link).then((ok) => {
      if (ok) {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
        return;
      }
      // 这个环境不让写剪贴板：选中文本让用户自己 Ctrl+C
      linkRef.current?.focus();
      linkRef.current?.select();
      setNote('这个环境不让自动复制，已选中链接，按 Ctrl+C 复制即可。');
    });
  };

  /** 解析链接 → 补齐剧集信息 → 弹卡片（不跳转） */
  const resolveShared = async (): Promise<void> => {
    const parsed = parseSharedLink(text);
    if (parsed === null) {
      setPreview(null);
      setNote('认不出这个链接。红果分享链接形如 …video-animation-share?video_id=剧号&vid=集号，请整条粘进来。');
      return;
    }
    setBusy(true);
    setNote('');
    try {
      const detail = await api.series(parsed.seriesId);
      let episodeId = parsed.episodeId;
      let no = parsed.no;
      let startAt = parsed.startAt;
      if (episodeId === '' || no <= 0) {
        if (episodeId === '') {
          // 分享的是整部剧：优先"上次看到的那一集"，否则第一集
          const resume = await api.progressFor(parsed.seriesId).catch(() => null);
          const picked =
            (resume === null ? undefined : detail.episodes.find((ep) => ep.episodeId === resume.episodeId)) ??
            detail.episodes[0];
          if (picked === undefined) throw new Error('这部剧暂时没有可播放的集');
          episodeId = picked.episodeId;
          no = picked.no;
          if (startAt <= 0 && resume !== null && resume.episodeId === picked.episodeId) startAt = resume.positionSec;
        } else {
          const hit = detail.episodes.find((ep) => ep.episodeId === episodeId);
          if (hit === undefined) throw new Error('这部剧里找不到这一集（可能已下架）');
          no = hit.no;
        }
      }
      setPreview({
        seriesId: parsed.seriesId,
        episodeId,
        no,
        startAt,
        title: detail.drama.title,
        cover: detail.drama.cover,
        episodeCount: detail.episodes.length,
      });
    } catch (err) {
      setPreview(null);
      setNote(`解析失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const startWatch = (): void => {
    if (preview === null) return;
    closeShare();
    location.hash = playHash(preview.seriesId, preview.episodeId, preview.no, preview.startAt);
  };

  const currentLink =
    current === null ? '' : hongguoShareLink(current.seriesId, current.episodeId, current.no, current.at);

  return (
    <div className="sharedlg" role="dialog" aria-modal="true" aria-label="分享续播">
      <button className="sharedlg__mask" aria-label="关闭" onClick={closeShare} />
      <div className="sharedlg__card">
        <header className="sharedlg__head">
          <div>
            <h2 className="sharedlg__title">分享续播</h2>
            <p className="sharedlg__sub">
              分享出去的是红果原链接；把别人发的链接粘回来，先给你看是哪部剧、第几集、从哪开始，再决定要不要看。
            </p>
          </div>
          <button className="sharedlg__close" onClick={closeShare} aria-label="关闭">
            ✕
          </button>
        </header>

        <section className="sharedlg__block">
          <p className="sharedlg__label">当前这一集</p>
          {current === null ? (
            <p className="sharedlg__hint">先在播放页打开一集，再回来点这里。</p>
          ) : (
            <>
              <div className="sharedlg__row">
                <input
                  className="sharedlg__input"
                  ref={linkRef}
                  readOnly
                  value={currentLink}
                  onFocus={(e) => e.target.select()}
                />
                <button className="sharedlg__btn sharedlg__btn--primary" onClick={copyCurrent}>
                  {copied ? '已复制' : '复制链接'}
                </button>
              </div>
              <p className="sharedlg__hint">
                第 {current.no} 集 · {fmt(current.at)}；链接里的 <code>no</code>/<code>t</code> 只给本软件解析，
                红果官方打开时按原样生效。
              </p>
            </>
          )}
        </section>

        <section className="sharedlg__block">
          <p className="sharedlg__label">打开别人分享的链接</p>
          <div className="sharedlg__row">
            <input
              className="sharedlg__input"
              placeholder="粘贴红果分享链接（…video-animation-share?video_id=…&vid=…）"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setPreview(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void resolveShared();
              }}
            />
            <button
              className="sharedlg__btn sharedlg__btn--primary"
              disabled={busy || text.trim() === ''}
              onClick={() => void resolveShared()}
            >
              {busy ? '解析中…' : '解析链接'}
            </button>
          </div>

          {preview !== null && (
            <div className="sharedlg__preview">
              {preview.cover !== '' && (
                <img className="sharedlg__cover" src={preview.cover} alt="" loading="lazy" />
              )}
              <div className="sharedlg__preview-main">
                <p className="sharedlg__preview-title">{preview.title}</p>
                <p className="sharedlg__preview-meta">
                  第 {preview.no} 集 / 共 {preview.episodeCount} 集 · {fmt(preview.startAt)}
                </p>
                <div className="sharedlg__preview-actions">
                  <button className="sharedlg__btn sharedlg__btn--primary" onClick={startWatch}>
                    开始观看
                  </button>
                  <button className="sharedlg__btn" onClick={() => setPreview(null)}>
                    换一个
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>

        {note !== '' && <p className="sharedlg__note">{note}</p>}

        <p className="sharedlg__foot">软件本身没有服务器，链接内容和红果原生分享一致，不经过任何中转。</p>
      </div>
    </div>
  );
}

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '从头开始';
  const total = Math.floor(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `从 ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} 开始`;
}
