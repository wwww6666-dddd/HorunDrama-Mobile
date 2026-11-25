import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { JSX } from 'react';
import type Player from 'xgplayer';
import { XgPlayer } from './XgPlayer.tsx';
import { PlayerBarExtras } from './PlayerBarExtras.tsx';
import type { DanmakuPrefs } from '../settings/danmaku.ts';

export interface DramaPlayerExtras {
  episodeCount: number;
  qualities?: string[];
  quality?: string;
  definition?: string;
  /** 控制条设置的倍速（面板里改） */
  rate?: number;
  onRate?: (value: number) => void;
  autoPlayNext?: boolean;
  onToggleAutoNext?: () => void;
  skipIntroSec?: number;
  skipOutroSec?: number;
  onSkipIntro?: (value: number) => void;
  onSkipOutro?: (value: number) => void;
  danmakuEnabled: boolean;
  danmakuPrefs: DanmakuPrefs;
  onDanmakuPrefs: (patch: Partial<DanmakuPrefs>) => void;
  danmakuText: string;
  onEpisodes: () => void;
  onQuality?: (value: string) => void;
  onPrev?: () => void;
  onNext?: () => void;
  onToggleDanmaku: () => void;
  onDanmakuText: (value: string) => void;
  onSendDanmaku: () => void;
}

export interface DramaPlayerProps {
  url: string;
  startAt?: number;
  rate?: number;
  /** 单击暂停/双击全屏（默认开） */
  clickToToggle?: boolean;
  /** 空格暂停、←/→ 快退快进、↑/↓ 切上下集（默认开） */
  shortcuts?: boolean;
  /** 在画面上滚滚轮切上下集（默认开；只在视频区域生效） */
  wheelSwitch?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  onReady?: (player: Player) => void;
  onTime?: (time: number, duration: number) => void;
  onPlaying?: (playing: boolean) => void;
  onEnded?: () => void;
  onError?: (message: string) => void;
  /** 全屏作用的宿主元素（页面容器）；不传就用播放器外壳。
   *  传页面容器才能让右侧操作栏、弹幕、简介在全屏里继续可见。 */
  fullscreenHost?: () => HTMLElement | null;
  /** 控制条里的选集/清晰度/上一集下一集/弹幕 */
  extras?: DramaPlayerExtras;
  /** 弹幕层等覆盖内容 */
  children?: ReactNode;
}

/**
 * 剧场播放页和推荐页共用的播放器外壳。
 *
 * 之前两个页面各写一套（点击/键盘/控制条扩展的挂载方式都不一样），
 * 改一处另一处就不一致。这里统一：xgplayer 实例、单击/双击、键盘、
 * 滚轮切集、控制条扩展全部在这一个组件里，页面只负责自己的外层 UI。
 */
export function DramaPlayer({
  url,
  startAt = 0,
  rate = 1,
  clickToToggle = true,
  shortcuts = true,
  wheelSwitch = true,
  onPrev,
  onNext,
  onReady,
  onTime,
  onPlaying,
  onEnded,
  onError,
  fullscreenHost,
  extras,
  children,
}: DramaPlayerProps): JSX.Element {
  const playerRef = useRef<Player | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const clickTimer = useRef<number | null>(null);
  const wheelAt = useRef(0);
  // 回调放进 ref，避免因为父组件每次渲染产生新函数而反复重绑监听
  const cbs = useRef({ onPrev, onNext });
  cbs.current = { onPrev, onNext };

  const togglePlay = (): void => {
    const player = playerRef.current;
    const media = player?.media as HTMLVideoElement | null | undefined;
    if (media === null || media === undefined) return;
    if (media.paused) void media.play().catch(() => undefined);
    else media.pause();
  };

  // 全屏状态同步到 <html> 上：推荐页的"控制条要不要抬离 dock"由这个 class 决定，
  // 比依赖 :fullscreen 的匹配范围更可靠（全屏元素是 .xgplayer，不是祖先）
  useEffect(() => {
    const sync = (): void => {
      document.documentElement.classList.toggle('is-player-fullscreen', document.fullscreenElement !== null);
    };
    sync();
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
      document.documentElement.classList.remove('is-player-fullscreen');
    };
  }, []);

  const toggleFullscreen = (): void => {
    // 全屏要作用在"页面容器"上，而不是播放器本身：
    // 否则点赞/评论/收藏栏、弹幕层、简介都在播放器子树外面，会跟着一起消失
    const host = fullscreenHost?.() ?? wrapRef.current;
    const player = playerRef.current;
    if (player === null) return;
    if (document.fullscreenElement !== null) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (host === null || host === undefined) {
      void player.getFullscreen(player.root ?? undefined).catch(() => undefined);
      return;
    }
    void host.requestFullscreen().catch(() => {
      // 容器不能全屏时退回播放器全屏，至少画面能全屏
      void player.getFullscreen(player.root ?? undefined).catch(() => undefined);
    });
  };

  // 键盘：两个页面同一套
  useEffect(() => {
    if (!shortcuts && onPrev === undefined && onNext === undefined) return;
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (event.code === 'Space') {
        event.preventDefault();
        togglePlay();
        return;
      }
      const player = playerRef.current;
      if (player === null) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        player.currentTime = Math.max(0, player.currentTime - 5);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        player.currentTime += 5;
      } else if (event.key === 'ArrowUp') {
        if (cbs.current.onPrev === undefined) return;
        event.preventDefault();
        cbs.current.onPrev();
      } else if (event.key === 'ArrowDown') {
        if (cbs.current.onNext === undefined) return;
        event.preventDefault();
        cbs.current.onNext();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcuts, onPrev, onNext]);

  // 滚轮切集：绑在外层容器上（点击层是它的兄弟节点，绑 player.root 收不到事件），
  // 只在视频区域生效并节流 700ms；控制条上的滚轮留给音量
  useEffect(() => {
    const root = wrapRef.current;
    if (!wheelSwitch || root === null) return;
    const onWheel = (event: Event): void => {
      const wheel = event as WheelEvent;
      const target = wheel.target as HTMLElement | null;
      if (target !== null && target.closest('.xgplayer-controls') !== null) return;
      if (Math.abs(wheel.deltaY) < 12) return;
      const now = Date.now();
      if (now - wheelAt.current < 700) return;
      const next = wheel.deltaY > 0 ? cbs.current.onNext : cbs.current.onPrev;
      if (next === undefined) return;
      wheelAt.current = now;
      wheel.preventDefault();
      next();
    };
    root.addEventListener('wheel', onWheel as EventListener, { passive: false });
    return () => root.removeEventListener('wheel', onWheel as EventListener);
  }, [wheelSwitch, url]);


  useEffect(() => {
    return () => {
      if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
      playerRef.current = null;
    };
  }, []);

  const onSurfaceClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (!clickToToggle) return;
    // 控制条/清晰度菜单/错误层自己的点击不能被当成"暂停"
    const target = event.target as HTMLElement | null;
    if (target !== null && target.closest('.xgplayer-controls, .xg-extras, .xg-quality, .xg-quality-mask') !== null) {
      return;
    }
    if (clickTimer.current !== null) {
      window.clearTimeout(clickTimer.current);
      clickTimer.current = null;
      toggleFullscreen();
      return;
    }
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null;
      togglePlay();
    }, 230);
  };

  const handleReady = (player: Player): void => {
    playerRef.current = player;
    // 把控制条扩展挂进 xgplayer 右侧按钮区（两个页面同一套挂载逻辑）
    const grid = player.root?.querySelector('.xg-right-grid');
    if (grid !== null && grid !== undefined) {
      let node = grid.querySelector<HTMLElement>('.xg-extras-host');
      if (node === null) {
        node = document.createElement('div');
        node.className = 'xg-extras-host';
        grid.appendChild(node);
      }
      setHost(node);
    }
    onReady?.(player);
  };

  return (
    <div className="drama-player" ref={wrapRef} onClick={onSurfaceClick}>
      <XgPlayer
        url={url}
        startAt={startAt}
        rate={rate}
        onReady={handleReady}
        onTime={(t, d) => onTime?.(t, d)}
        onPlaying={(v) => onPlaying?.(v)}
        onEnded={() => onEnded?.()}
        onError={(m) => onError?.(m)}
        fullscreenTarget={fullscreenHost}
      />
      {extras !== undefined && host !== null && (
        <PlayerBarExtras
          host={host}
          episodeCount={extras.episodeCount}
          qualities={extras.qualities ?? []}
          quality={extras.quality ?? ''}
          definition={extras.definition}
          rate={extras.rate ?? rate}
          onRate={extras.onRate ?? (() => undefined)}
          autoPlayNext={extras.autoPlayNext !== false}
          onToggleAutoNext={extras.onToggleAutoNext ?? (() => undefined)}
          skipIntroSec={extras.skipIntroSec ?? 0}
          skipOutroSec={extras.skipOutroSec ?? 0}
          onSkipIntro={extras.onSkipIntro ?? (() => undefined)}
          onSkipOutro={extras.onSkipOutro ?? (() => undefined)}
          danmakuEnabled={extras.danmakuEnabled}
          danmakuPrefs={extras.danmakuPrefs}
          onDanmakuPrefs={extras.onDanmakuPrefs}
          onEpisodes={extras.onEpisodes}
          onQuality={extras.onQuality ?? (() => undefined)}
          onPrev={extras.onPrev}
          onNext={extras.onNext}
          danmakuText={extras.danmakuText}
          onToggleDanmaku={extras.onToggleDanmaku}
          onDanmakuText={extras.onDanmakuText}
          onSendDanmaku={extras.onSendDanmaku}
        />
      )}
      {children}
    </div>
  );
}
