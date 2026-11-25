import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import Player from 'xgplayer';
import 'xgplayer/dist/index.min.css';

export interface XgPlayerProps {
  url: string;
  startAt: number;
  rate: number;
  onReady?: (player: Player) => void;
  onTime?: (time: number, duration: number) => void;
  onEnded?: () => void;
  onPlaying?: (playing: boolean) => void;
  onError?: (message: string) => void;
  /** xgplayer 自带全屏按钮作用的目标（页面容器）；不传就是播放器本身 */
  fullscreenTarget?: () => HTMLElement | null;
}

/**
 * 播放器内核：直接用 xgplayer 的控制条/进度条/音量/倍速/画中画/全屏。
 * 我们只保留自己的外层壳（标题、右侧操作栏、弹幕层）。
 */
export function XgPlayer({
  url,
  startAt,
  rate,
  onReady,
  onTime,
  onEnded,
  onPlaying,
  onError,
  fullscreenTarget,
}: XgPlayerProps): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const playerRef = useRef<Player | null>(null);
  const startRef = useRef(startAt);
  startRef.current = startAt;

  // 回调全部走 ref 转发**最新一次渲染**的版本。
  // 播放器实例只在挂载时创建一次（换集不重建，画中画/全屏才保得住），
  // 事件监听里如果直接用创建时的闭包，就会一直调用"第一集那次渲染"的函数：
  // 自动下一集用它算 `当前集 + 1`，永远算回第一集的下一集，
  // 从第二集开始播完就再也切不动（只剩「重播」）。
  const cbs = useRef({ rate, onReady, onTime, onEnded, onPlaying, onError });
  cbs.current = { rate, onReady, onTime, onEnded, onPlaying, onError };

  /** 首次创建时用的地址；之后的换集走 src 原地切换 */
  const firstUrl = useRef(url);
  const created = useRef(false);
  /** 换源后需要恢复起播位置/倍速（只做一次） */
  const pendingApply = useRef(false);

  useEffect(() => {
    if (host.current === null || firstUrl.current === '' || created.current) return;
    created.current = true;
    const player = new Player({
      el: host.current,
      url: firstUrl.current,
      width: '100%',
      height: '100%',
      autoplay: false,
      playsinline: true,
      pip: true,
      download: false,
      mini: false,
      screenShot: false,
      rotate: false,
      playbackRate: [0.75, 1, 1.25, 1.5, 2],
      fullscreen: true,
      cssFullscreen: true,
      // 全屏作用在页面容器上：右侧点赞/评论/收藏栏、弹幕层、简介都在容器里，
      // 否则它们会在播放器子树外面，一全屏就消失
      ...(fullscreenTarget?.() ? { fullscreenTarget: fullscreenTarget() as HTMLElement } : {}),
      keyShortcut: true,
      volume: 0.9,
      lang: 'zh',
      closeVideoClick: true,
      closeVideoDblclick: true,
    });
    playerRef.current = player;

    // 注意：单击/双击不在这里处理。DramaPlayer 已经在容器上做了
    // （带 target 过滤），两边都绑会导致"双击进全屏又立刻退出/暂停"。
    // 这里只保留音量滚轮。
    let wheelBound = false;
    const onWheel = (event: WheelEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target === null || target.closest('.xgplayer-volume, .xgplayer-slider') === null) return;
      event.preventDefault();
      event.stopPropagation();
      const media = player.media as HTMLVideoElement | null;
      if (media === null) return;
      const current = media.muted ? 0 : media.volume;
      const next = Math.min(1, Math.max(0, current + (event.deltaY < 0 ? 0.05 : -0.05)));
      media.muted = next === 0;
      media.volume = next;
    };
    const bindWheel = (): void => {
      if (wheelBound || player.root === null) return;
      wheelBound = true;
      player.root.addEventListener('wheel', onWheel, { passive: false });
    };

    const applyPlayback = (): void => {
      const at = startRef.current;
      if (at > 1) {
        try {
          player.currentTime = at;
        } catch {
          /* 忽略 seek 失败 */
        }
      }
      try {
        player.playbackRate = cbs.current.rate;
      } catch {
        /* 忽略倍速失败 */
      }
      void player.play().catch(() => undefined);
    };

    let started = false;
    const seekStart = (): void => {
      if (started) return;
      started = true;
      applyPlayback();
      pendingApply.current = false;
      cbs.current.onReady?.(player);
      bindWheel();
    };

    // 只在两种情况下恢复起播位置：首次 canplay、换源后的第一次 canplay。
    // 不能每次 canplay 都 seek，否则用户拖进度条会被拉回去。
    /**
     * 手机竖屏：竖版短剧铺满全屏（轻微裁边），横版剧保持完整画面（上下留黑）。
     * 只在窄屏生效，桌面窗口宽的时候仍旧原样 contain。
     */
    const fitVideo = (): void => {
      const media = player.media as HTMLVideoElement | null;
      if (media === null || media.videoWidth === 0) return;
      if (window.innerWidth > 900) {
        media.style.objectFit = '';
        return;
      }
      const ratio = media.videoWidth / media.videoHeight;
      media.style.objectFit = ratio < 0.95 ? 'cover' : 'contain';
    };
    player.on('loadedmetadata', fitVideo);
    player.on('loadeddata', fitVideo);

    const onCanPlay = (): void => {
      fitVideo();
      if (started) {
        if (pendingApply.current) {
          pendingApply.current = false;
          applyPlayback();
        }
        return;
      }
      seekStart();
    };

    player.on('canplay', onCanPlay);
    player.on('timeupdate', () => {
      const onTime = cbs.current.onTime;
      onTime?.(player.currentTime, Number.isFinite(player.duration) ? player.duration : 0);
    });
    player.on('ended', () => cbs.current.onEnded?.());
    player.on('play', () => cbs.current.onPlaying?.(true));
    player.on('pause', () => cbs.current.onPlaying?.(false));
    player.on('error', () => {
      const media = player.media as HTMLVideoElement | null;
      cbs.current.onError?.(media?.error?.message ?? '播放失败');
    });

    return () => {
      player.root?.removeEventListener('wheel', onWheel, false);
      playerRef.current = null;
      try {
        player.destroy();
      } catch {
        /* 已销毁 */
      }
      // React StrictMode（开发态）会把 effect 跑两遍：setup → cleanup → setup。
      // 如果这里不把 created 复位，第二次 setup 会以为"已经创建过"直接 return，
      // 结果就是开发环境播放器永远不出现（生产构建不会双跑，所以以前没暴露）。
      created.current = false;
    };
    // 只在卸载时销毁；换集不会走到这里
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 换集：原地换**媒体元素**的 src，元素本身不重建 → 画中画、全屏都保留。
  // 之前用的是 player.src 赋值，但播放器已经处于 ended 状态时它会忽略这次赋值，
  // 表现就是"自动下一集切了路由，画面却停在上一集的『重播』按钮上"。
  useEffect(() => {
    const player = playerRef.current;
    if (player === null || url === '') return;
    const media = player.media as HTMLVideoElement | null;
    if (media === null) return;
    const current = media.getAttribute('src') ?? '';
    if (current === url) return;
    pendingApply.current = true;
    try {
      player.pause();
    } catch {
      /* 忽略 */
    }
    try {
      media.src = url;
      media.load();
      // 同时驱动播放器状态机：否则 ended 状态里的"重播"浮层可能还留着
      try {
        player.play();
      } catch {
        /* 忽略 */
      }
      void media.play().catch(() => undefined);
    } catch {
      /* 忽略 */
    }
  }, [url]);

  useEffect(() => {
    const player = playerRef.current;
    if (player !== null) {
      try {
        player.playbackRate = rate;
      } catch {
        /* 忽略 */
      }
    }
  }, [rate]);

  return <div className="xg-host" ref={host} />;
}
