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
  /** 每次起播/换源递增；晚到的 seek/解码回调不能把旧的一次起播重新拉起来 */
  const applyToken = useRef(0);

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
  /** 换源后需要恢复起播位置（只做一次，且必须对应当前这次换源） */
  const loadSeq = useRef(0);
  const pendingSeq = useRef(0);

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
    const mediaEl = player.media as HTMLVideoElement | null;

    /**
     * 换源时 media 会重新加载，部分 WebView 会把 playbackRate 归到 1x。
     * 不能只依赖 canplay：它有时早于恢复逻辑，所以在 loadedmetadata/canplay/playing
     * 三个阶段都补一次；只在 pendingSeq（刚换源且序号对应）期间做，
     * 避免用户手动切倍速后被覆盖。
     */
    const restorePendingRate = (): void => {
      if (pendingSeq.current === 0 || pendingSeq.current !== loadSeq.current || mediaEl === null) return;
      const next = cbs.current.rate;
      try {
        mediaEl.defaultPlaybackRate = next;
        mediaEl.playbackRate = next;
      } catch {
        /* 忽略倍速恢复失败 */
      }
    };
    mediaEl?.addEventListener('loadedmetadata', restorePendingRate);
    mediaEl?.addEventListener('canplay', restorePendingRate);
    mediaEl?.addEventListener('playing', restorePendingRate);

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
      const player = playerRef.current;
      if (player === null) return;
      const media = player.media as HTMLVideoElement | null;
      if (media === null) {
        try {
          player.playbackRate = cbs.current.rate;
        } catch {
          /* 忽略倍速失败 */
        }
        void player.play().catch(() => undefined);
        return;
      }

      const token = ++applyToken.current;
      const at = startRef.current;

      // 倍速直接写到原生 media：只改 xgplayer 的属性在部分 WebView 上不会同步音频，
      // 表现为画面变速而声音仍按 1× 走（或反过来），也就是用户听到的音画不同步。
      media.defaultPlaybackRate = cbs.current.rate;
      media.playbackRate = cbs.current.rate;
      try {
        player.playbackRate = cbs.current.rate;
      } catch {
        /* 忽略倍速失败 */
      }

      const playNow = (): void => {
        if (token !== applyToken.current) return;
        // 双轨都解码出第一帧/第一段音频后再播放：视频有画面、音频有数据，
        // 避免"音频先出声、视频还在 seek/解码"造成的起播音画不同步。
        const webkit = media as HTMLVideoElement & {
          webkitAudioDecodedByteCount?: number;
          webkitVideoDecodedByteCount?: number;
        };
        let waited = 0;
        const waitBothTracks = (): void => {
          if (token !== applyToken.current) return;
          const audioReady = webkit.webkitAudioDecodedByteCount === undefined
            || webkit.webkitAudioDecodedByteCount > 0;
          const videoReady = webkit.webkitVideoDecodedByteCount === undefined
            || webkit.webkitVideoDecodedByteCount > 0;
          if ((audioReady && videoReady && media.readyState >= 3) || waited >= 900) {
            void player.play().catch(() => undefined);
            void media.play().catch(() => undefined);
            return;
          }
          waited += 50;
          window.setTimeout(waitBothTracks, 50);
        };
        waitBothTracks();
      };

      const afterSeek = (): void => playNow();
      if (at > 1 && Math.abs(media.currentTime - at) > 0.08) {
        let settled = false;
        const onSeeked = (): void => {
          if (settled) return;
          settled = true;
          afterSeek();
        };
        media.addEventListener('seeked', onSeeked, { once: true });
        try {
          media.currentTime = at;
        } catch {
          settled = true;
          afterSeek();
          return;
        }
        // 某些机型 seek 会卡住不派发 seeked；超时后仍然起播，不让页面一直等
        window.setTimeout(() => {
          if (settled) return;
          settled = true;
          afterSeek();
        }, 1200);
      } else {
        afterSeek();
      }
    };

    let started = false;
    const seekStart = (): void => {
      if (started) return;
      started = true;
      applyPlayback();
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
        // 只消费"当前这一次换源"的 canplay：快速连切时旧 URL 的 canplay 可能晚到，
        // 若在它上面恢复新集的 startAt，会 seek 错位置、音画一起跳。
        if (pendingSeq.current !== 0 && pendingSeq.current === loadSeq.current) {
          pendingSeq.current = 0;
          applyPlayback();
        }
        return;
      }
      seekStart();
    };

    const onLoadStart = (): void => {
      // 新源真正开始加载时才把序号落到 pendingSeq：旧源的 canplay 早于
      // 新源的 loadstart，因此不会消费掉新集的恢复状态。
      if (loadSeq.current !== 0) pendingSeq.current = loadSeq.current;
    };
    mediaEl?.addEventListener('loadstart', onLoadStart);

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
      applyToken.current += 1;
      mediaEl?.removeEventListener('loadstart', onLoadStart);
      mediaEl?.removeEventListener('loadedmetadata', restorePendingRate);
      mediaEl?.removeEventListener('canplay', restorePendingRate);
      mediaEl?.removeEventListener('playing', restorePendingRate);
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
    applyToken.current += 1;
    loadSeq.current += 1;
    try {
      // 先把新速率写进 media，再 load：部分内核 load 后会把 playbackRate 重置成 1x。
      media.defaultPlaybackRate = cbs.current.rate;
      media.playbackRate = cbs.current.rate;
    } catch {
      /* 忽略 */
    }
    try {
      player.pause();
    } catch {
      /* 忽略 */
    }
    try {
      // 只换源并 load，不在 metadata 到位前抢跑 play：
      // 旧实现 load() 后立刻 player.play()/media.play()，音频会先从 0 秒出声，
      // 随后 canplay 再 seek 回 startAt，切换清晰度/切集时就会有一段明显不同步。
      // 现在统一等 canplay → applyPlayback（先 seek 再 play），音画从同一时间点起步。
      media.src = url;
      media.load();
    } catch {
      /* 忽略 */
    }
  }, [url]);

  useEffect(() => {
    const player = playerRef.current;
    if (player !== null) {
      const media = player.media as HTMLVideoElement | null;
      if (media !== null) {
        media.defaultPlaybackRate = rate;
        media.playbackRate = rate;
      }
      try {
        player.playbackRate = rate;
      } catch {
        /* 忽略 */
      }
    }
  }, [rate]);

  return <div className="xg-host" ref={host} />;
}
