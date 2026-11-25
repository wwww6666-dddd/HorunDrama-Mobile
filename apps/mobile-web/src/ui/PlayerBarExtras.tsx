import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { JSX } from 'react';
import { DANMAKU_COLORS, COVERAGE_OPTIONS, SIZE_OPTIONS, type DanmakuPrefs } from '../settings/danmaku.ts';

export interface PlayerBarExtrasProps {
  host: HTMLElement;
  episodeCount: number;
  /** 当前剧集可选的清晰度档位（仅作展示过滤；服务端支持全部档位） */
  qualities: string[];
  quality: string;
  /** 当前真正在播的画质（自动升清后会变）；不传则只显示档位名 */
  definition?: string;
  /** 当前倍速 */
  rate: number;
  onRate: (value: number) => void;
  /** 是否自动连播下一集 */
  autoPlayNext: boolean;
  onToggleAutoNext: () => void;
  skipIntroSec: number;
  skipOutroSec: number;
  onSkipIntro: (value: number) => void;
  onSkipOutro: (value: number) => void;
  danmakuEnabled: boolean;
  danmakuPrefs: DanmakuPrefs;
  onDanmakuPrefs: (patch: Partial<DanmakuPrefs>) => void;
  danmakuText: string;
  onEpisodes: () => void;
  onQuality: (value: string) => void;
  /** 有值才显示"上一集/下一集"（控制条里和方向键、滚轮共用同一套） */
  onPrev?: () => void;
  onNext?: () => void;
  onToggleDanmaku: () => void;
  onDanmakuText: (value: string) => void;
  onSendDanmaku: () => void;
}

interface QualityOption {
  value: string;
  label: string;
  note: string;
}

/**
 * 清晰度选项。注意这里的文案就是给用户看的：不再出现一个孤零零的「自动」
 * ——播放器里那个位置用户只会理解为"清晰度"，所以按钮直接显示当前画质。
 *
 * 2.0.0 起这个列表是**常量**：即使 `job.available` 一时为空（切档/等转码），
 * 按钮也不会消失；之前用 `qualities.length > 0` 作为渲染条件，用户从 1080p
 * 切到 360p 时任务重建 → 按钮直接没了，看起来像"切档把按钮切没了"。
 */
const QUALITY_OPTIONS: QualityOption[] = [
  { value: '', label: '自动', note: '先播能拿到的，高清好了自动换' },
  { value: 'smooth', label: '流畅 360p', note: '最省流量，秒开' },
  { value: '480p', label: '标清 480p', note: '需要转码，等一会儿' },
  { value: '720p', label: '高清 720p', note: '需要转码，画质明显更好' },
  { value: '1080p', label: '超清 1080p', note: '最清晰，转码最慢' },
];

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
const SKIP_OPTIONS = [0, 5, 10, 15, 30, 60];

/** 返回清晰度的中文标签；未知值原样显示。 */
export function qualityLabel(value: string): string {
  return QUALITY_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

/**
 * 全屏宿主：网页全屏时浏览器只渲染全屏元素子树，portal 到 body 的菜单/面板
 * 会直接不可见（用户反馈的"全屏点清晰度没反应"根因）。所以统一 portal 到
 * `document.fullscreenElement ?? document.body`。
 */
function usePortalRoot(): HTMLElement {
  const [root, setRoot] = useState<HTMLElement>(
    () => (document.fullscreenElement as HTMLElement | null) ?? document.body,
  );
  useEffect(() => {
    const sync = (): void => setRoot((document.fullscreenElement as HTMLElement | null) ?? document.body);
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, []);
  return root;
}

/**
 * 把选集/清晰度/弹幕/播放器设置嵌进 xgplayer 自己的控制条。
 *
 * 清晰度菜单和设置面板**不挂在这个 portal 里**：控制条内部有 overflow/层叠上下文，
 * 而且不带遮罩时点空白处会直接穿透到视频（暂停/全屏）。所以它们单独 portal 到
 * 全屏宿主，用 fixed 定位贴到按钮旁边。
 */
export function PlayerBarExtras({
  host,
  episodeCount,
  qualities,
  quality,
  definition = '',
  rate,
  onRate,
  autoPlayNext,
  onToggleAutoNext,
  skipIntroSec,
  skipOutroSec,
  onSkipIntro,
  onSkipOutro,
  danmakuEnabled,
  danmakuPrefs,
  onDanmakuPrefs,
  danmakuText,
  onEpisodes,
  onQuality,
  onPrev,
  onNext,
  onToggleDanmaku,
  onDanmakuText,
  onSendDanmaku,
}: PlayerBarExtrasProps): JSX.Element {
  const root = usePortalRoot();
  const [anchor, setAnchor] = useState<{ left: number; bottom: number; right: number } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const settingsBtnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const label = definition !== '' ? definition : qualityLabel(quality);

  /** 清晰度菜单：按按钮位置向上弹出。 */
  const openMenu = (): void => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    setAnchor({
      left: rect.left,
      right: Math.max(12, window.innerWidth - rect.right),
      bottom: Math.max(12, window.innerHeight - rect.top + 10),
    });
  };

  useEffect(() => {
    if (anchor === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setAnchor(null);
    };
    const onResize = (): void => setAnchor(null);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [anchor]);

  // 设置面板：从齿轮按钮"流体变形"长成右侧面板。用 Web Animations 做 FLIP，
  // 比纯 CSS 更能保证从按钮位置出发、尺寸/圆角同时过渡。
  useLayoutEffect(() => {
    if (!settingsOpen) return;
    const panel = panelRef.current;
    const button = settingsBtnRef.current;
    if (panel === null || button === null) return;
    const from = button.getBoundingClientRect();
    const to = panel.getBoundingClientRect();
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const scale = Math.max(0.12, from.width / Math.max(1, to.width));
    panel.animate(
      [
        {
          transformOrigin: 'center center',
          transform: `translate(${dx}px, ${dy}px) scale(${scale})`,
          borderRadius: '999px',
          opacity: 0.2,
        },
        { transform: 'translate(0, 0) scale(1)', borderRadius: '20px', opacity: 1 },
      ],
      { duration: 420, easing: 'cubic-bezier(.22,1.25,.36,1)', fill: 'both' },
    );
  }, [settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSettingsOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [settingsOpen]);

  const panel = (
    <>
      <div className="pset-mask" role="presentation" onClick={() => setSettingsOpen(false)} />
      <section
        className="pset"
        role="dialog"
        aria-label="播放器设置"
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="pset__head">
          <strong>播放器设置</strong>
          <span>即时生效并保存</span>
          <button className="pset__close" onClick={() => setSettingsOpen(false)} aria-label="关闭设置">
            ✕
          </button>
        </header>

        <div className="pset__body">
          <section className="pset__section">
            <h4>清晰度</h4>
            <div className="pset__chips">
              {QUALITY_OPTIONS.map((option) => (
                <button
                  key={option.value === '' ? 'auto' : option.value}
                  className="pset__chip"
                  data-active={option.value === quality}
                  title={option.note}
                  onClick={() => onQuality(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="pset__hint">切档会保留当前进度；高清需要先转码，期间继续播当前画面。</p>
          </section>

          <section className="pset__section">
            <h4>倍速</h4>
            <div className="pset__chips">
              {SPEEDS.map((speed) => (
                <button
                  key={speed}
                  className="pset__chip"
                  data-active={Math.abs(rate - speed) < 0.001}
                  onClick={() => onRate(speed)}
                >
                  {speed.toFixed(2).replace(/0$/, '')}x
                </button>
              ))}
            </div>
          </section>

          <section className="pset__section">
            <h4>
              弹幕
              <button
                className={`pset__switch${danmakuEnabled ? ' is-on' : ''}`}
                onClick={onToggleDanmaku}
                aria-pressed={danmakuEnabled}
              >
                <span />
              </button>
            </h4>

            <label className="pset__row">
              <span>不透明度</span>
              <input
                type="range"
                min={0.3}
                max={1}
                step={0.05}
                value={danmakuPrefs.opacity}
                onChange={(e) => onDanmakuPrefs({ opacity: Number(e.target.value) })}
              />
              <b>{Math.round(danmakuPrefs.opacity * 100)}%</b>
            </label>

            <div className="pset__row pset__row--stack">
              <span>字号</span>
              <div className="pset__chips">
                {SIZE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    className="pset__chip pset__chip--sm"
                    data-active={danmakuPrefs.size === option.value}
                    onClick={() => onDanmakuPrefs({ size: option.value })}
                  >
                    {option.label}
                  </button>
                ))}
                <button
                  className="pset__chip pset__chip--sm"
                  data-active={danmakuPrefs.bold}
                  onClick={() => onDanmakuPrefs({ bold: !danmakuPrefs.bold })}
                >
                  加粗
                </button>
              </div>
            </div>

            <div className="pset__row">
              <span>颜色</span>
              <div className="pset__colors">
                {DANMAKU_COLORS.map((color) => (
                  <button
                    key={color.value}
                    className="pset__color"
                    style={{ background: color.value }}
                    data-active={danmakuPrefs.color === color.value}
                    title={color.label}
                    aria-label={`弹幕颜色 ${color.label}`}
                    onClick={() => onDanmakuPrefs({ color: color.value })}
                  />
                ))}
              </div>
            </div>

            <div className="pset__row pset__row--stack">
              <span>显示区域</span>
              <div className="pset__chips">
                {COVERAGE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    className="pset__chip pset__chip--sm"
                    data-active={Math.abs(danmakuPrefs.coverage - option.value) < 0.001}
                    onClick={() => onDanmakuPrefs({ coverage: option.value })}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="pset__section">
            <h4>播放</h4>
            <label className="pset__check">
              <input type="checkbox" checked={autoPlayNext} onChange={onToggleAutoNext} />
              <span>播完自动连播下一集</span>
            </label>

            <div className="pset__row pset__row--stack">
              <span>跳过片头</span>
              <div className="pset__chips">
                {SKIP_OPTIONS.map((sec) => (
                  <button
                    key={sec}
                    className="pset__chip pset__chip--sm"
                    data-active={skipIntroSec === sec}
                    onClick={() => onSkipIntro(sec)}
                  >
                    {sec === 0 ? '不跳过' : `${sec} 秒`}
                  </button>
                ))}
              </div>
            </div>

            <div className="pset__row pset__row--stack">
              <span>跳过片尾</span>
              <div className="pset__chips">
                {SKIP_OPTIONS.map((sec) => (
                  <button
                    key={sec}
                    className="pset__chip pset__chip--sm"
                    data-active={skipOutroSec === sec}
                    onClick={() => onSkipOutro(sec)}
                  >
                    {sec === 0 ? '不跳过' : `${sec} 秒`}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <p className="pset__foot">快捷键：空格 播放/暂停 · ← → 快退/快进 · ↑ ↓ 切集 · F 全屏 · D 弹幕</p>
        </div>
      </section>
    </>
  );

  return createPortal(
    <div className="xg-extras">
      {onPrev !== undefined && (
        <button className="xg-extras__btn" onClick={onPrev} title="上一集（↑ 或滚轮上滚）">
          上一集
        </button>
      )}
      {onNext !== undefined && (
        <button className="xg-extras__btn" onClick={onNext} title="下一集（↓ 或滚轮下滚）">
          下一集
        </button>
      )}
      <button className="xg-extras__btn" onClick={onEpisodes} title="选集">
        选集 {episodeCount > 0 ? `全${episodeCount}集` : ''}
      </button>

      <button
        ref={buttonRef}
        type="button"
        className="xg-extras__btn xg-extras__btn--quality"
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        title="切换清晰度"
        onClick={() => (anchor === null ? openMenu() : setAnchor(null))}
      >
        {label}
        <span className="xg-extras__caret" aria-hidden="true">
          ⌃
        </span>
      </button>

      <button
        ref={settingsBtnRef}
        type="button"
        className="xg-extras__btn xg-extras__btn--settings"
        title="播放器设置"
        aria-haspopup="dialog"
        aria-expanded={settingsOpen}
        onClick={() => setSettingsOpen((v) => !v)}
      >
        <span aria-hidden="true">⚙</span> 设置
      </button>

      <button className="xg-extras__btn" onClick={onToggleDanmaku} title="弹幕">
        弹幕{danmakuEnabled ? '开' : '关'}
      </button>
      <input
        className="xg-extras__input"
        placeholder="发条弹幕..."
        value={danmakuText}
        onChange={(e) => onDanmakuText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSendDanmaku();
        }}
      />
      <button className="xg-extras__btn" onClick={onSendDanmaku}>
        发送
      </button>

      {anchor !== null &&
        createPortal(
          <>
            <div
              className="xg-quality-mask"
              role="presentation"
              onClick={(event) => {
                event.stopPropagation();
                setAnchor(null);
              }}
            />
            <div
              className="xg-quality"
              role="dialog"
              aria-label="清晰度"
              style={{ left: anchor.left, right: anchor.right, bottom: anchor.bottom }}
            >
              {QUALITY_OPTIONS.filter((o) => o.value === '' || qualities.length === 0 || qualities.includes(o.value)).map(
                (option) => {
                  const active = option.value === quality;
                  return (
                    <button
                      key={option.value === '' ? 'auto' : option.value}
                      type="button"
                      className="xg-quality__item"
                      data-active={active}
                      onClick={() => {
                        setAnchor(null);
                        // 同一档位再点一次也重新发起（高清取不到时可以原地重试）
                        onQuality(option.value);
                      }}
                    >
                      <span className="xg-quality__label">{option.label}</span>
                      <span className="xg-quality__note">{option.note}</span>
                      {active && (
                        <span className="xg-quality__check" aria-hidden="true">
                          ✓
                        </span>
                      )}
                    </button>
                  );
                },
              )}
            </div>
          </>,
          root,
        )}

      {settingsOpen && createPortal(panel, root)}
    </div>,
    host,
  );
}
