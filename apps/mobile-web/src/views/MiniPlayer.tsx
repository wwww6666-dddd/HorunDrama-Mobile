import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { api, type PlayJob, type SeriesDetail } from '../api.ts';
import { miniHash, type MiniRoute } from '../routes.ts';
import { IconFullscreenExit, IconNext, IconPause, IconPlay, IconPrev } from '../ui/icons.tsx';

/**
 * 迷你播放器（系统级小窗）。
 *
 * 与完整播放页的区别：
 *  - 只有画面，没有任何应用外壳；
 *  - 控制条只在鼠标悬停时出现，其余时间不挡画面；
 *  - 顶部一条窄的拖动区负责移动窗口，双击画面「还原」回主窗口；
 *  - 打开时带着主窗口的播放位置（?t=），关掉再还原可以接着看。
 */
export function MiniPlayer({ route }: { route: MiniRoute }): JSX.Element {
  const [detail, setDetail] = useState<SeriesDetail | null>(null);
  const [job, setJob] = useState<PlayJob | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [hover, setHover] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const resumed = useRef(false);

  useEffect(() => {
    let alive = true;
    api
      .series(route.seriesId)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [route.seriesId]);

  // 取流/转码：小窗里不做进度界面，只在黑屏上显示一行状态
  useEffect(() => {
    let cancelled = false;
    setJob(null);
    resumed.current = false;
    void (async () => {
      try {
        let current = await api.play(route.episodeId);
        if (cancelled) return;
        setJob(current);
        while (!cancelled && current.state !== 'ready' && current.state !== 'failed') {
          await new Promise((r) => setTimeout(r, 1200));
          if (cancelled) return;
          current = await api.prepare(current.jobId);
          if (cancelled) return;
          setJob(current);
        }
      } catch {
        if (!cancelled) setJob(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [route.episodeId]);

  useEffect(() => {
    const v = videoRef.current;
    if (v === null || job?.state !== 'ready') return;
    v.play().catch(() => undefined);
  }, [job?.state, job?.url]);

  const onLoadedMetadata = (): void => {
    const v = videoRef.current;
    if (v === null) return;
    if (!resumed.current) {
      resumed.current = true;
      if (route.startAt > 0) {
        v.currentTime = route.startAt;
        setTime(route.startAt);
      }
    }
    // 让主进程按真实比例校正窗口（16:9 / 9:16 都能贴合）
    void window.yimu?.resizeMini?.({ w: v.videoWidth, h: v.videoHeight });
  };

  const togglePlay = useCallback((): void => {
    const v = videoRef.current;
    if (v === null) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  }, []);

  const neighbor = (delta: number): void => {
    if (detail === null) return;
    const index = detail.episodes.findIndex((e) => e.episodeId === route.episodeId);
    const target = detail.episodes[index + delta];
    if (target === undefined) return;
    location.hash = miniHash(route.seriesId, target.episodeId, target.no, 0);
  };

  const restore = (): void => {
    void window.yimu?.focusMain?.();
  };

  const close = (): void => {
    void window.yimu?.closeMini?.();
  };

  const progress = duration > 0 ? Math.min(100, (time / duration) * 100) : 0;
  const title = detail?.drama.title ?? '播放中';
  const episodeNo = detail === null ? route.no : (detail.episodes.findIndex((e) => e.episodeId === route.episodeId) + 1 || route.no);

  return (
    <div className="mini" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {/* 顶部拖动条：空白处可拖动窗口（视频区域留给双击/点击） */}
      <div className="mini__drag" />

      <video
        ref={videoRef}
        className="mini__video"
        src={job?.state === 'ready' ? job.url : undefined}
        playsInline
        autoPlay={false}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration || job?.durationSec || 0)}
        onDoubleClick={restore}
        onClick={togglePlay}
      />

      {job !== null && job.state !== 'ready' && (
        <div className="mini__status">
          {job.state === 'failed' ? `无法播放：${job.error}` : `${job.message} ${Math.round(job.progress * 100)}%`}
        </div>
      )}

      <div className="mini__hud" data-visible={hover || !playing}>
        <button type="button" title="上一集" onClick={() => neighbor(-1)}>
          <IconPrev size={16} />
        </button>
        <button type="button" title={playing ? '暂停' : '播放'} onClick={togglePlay}>
          {playing ? <IconPause size={16} /> : <IconPlay size={16} />}
        </button>
        <button type="button" title="下一集" onClick={() => neighbor(1)}>
          <IconNext size={16} />
        </button>

        <span className="mini__label">
          {title} · 第 {episodeNo} 集
        </span>

        <button type="button" title="还原到主窗口（双击画面也可以）" onClick={restore}>
          <IconFullscreenExit size={15} />
        </button>
        <button type="button" className="mini__close" title="关闭小窗" onClick={close}>
          ✕
        </button>
      </div>

      <div className="mini__progress" aria-hidden="true">
        <span style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}
