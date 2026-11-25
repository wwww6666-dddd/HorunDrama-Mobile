/**
 * 预加载队列：以当前集为中心，向前/向后各预加载若干集（设置里可改，默认 5）。
 *
 * 只做两件事：
 *   1. 把这一集的高清准备好（走 startUpgradeJob：命中缓存直接跳过、并发会合并）；
 *   2. 串行执行，别把转码 CPU 抢光 —— 正在播的那一集优先。
 *
 * 每次新的播放/切集都会重新排一次队（世代号 +1）。
 *
 * 注意（2026-11-17 修）：老实现是"已在跑就直接 return"，而收尾的
 * `finally { if (gen === generation) running = false }` 在计划被取代时不会执行 ——
 * `running` 永远卡在 true，之后**再也启动不了预加载**。
 * 现在改成：新计划只覆盖 `latest`，常驻循环每轮读最新计划；
 * 收尾时如果发现期间又来了新计划，就再起一轮（避免"恰好卡在退出瞬间"的死角）。
 */
import { getSettings } from '../store/settings.ts';
import { createLogger } from '../util/log.ts';
import { getJob, startUpgradeJob } from './jobs.ts';
import { existingMediaAny } from './transcode.ts';

const log = createLogger('preload');

let generation = 0;
let running = false;
/** 最近一次排队的计划；循环每轮重新读它，被覆盖就切到新的 */
let latest: PreloadPlan | null = null;
/** 循环最近处理到的世代，用来判断退出时是否还有没跑的新计划 */
let servedGen = 0;

export interface PreloadPlan {
  /** 以当前集为中心的前后集 id（不含当前集） */
  episodeIds: string[];
  quality: string;
  hevc: boolean;
}

/** 重新排队：上一个计划立刻作废（不打断正在转的那一集，转完就切新计划） */
export function schedulePreload(plan: PreloadPlan): number {
  const limit = getSettings().preloadCount;
  // 前后各 limit 集：调用方按"离当前集由近到远"给顺序，这里再截断一次
  const wanted = plan.episodeIds.filter((id) => /^\d{6,25}$/.test(id)).slice(0, limit <= 0 ? 0 : limit * 2);
  generation += 1;
  latest = wanted.length === 0 ? null : { episodeIds: wanted, quality: plan.quality, hevc: plan.hevc };
  if (latest !== null) kick();
  return wanted.length;
}

function kick(): void {
  if (running || latest === null) return;
  running = true;
  void runLoop().finally(() => {
    running = false;
    // 期间又排了新计划（恰好在退出瞬间）：再起一轮，否则就永远不预加载了
    if (latest !== null && servedGen !== generation) kick();
  });
}

async function runLoop(): Promise<void> {
  for (;;) {
    const plan = latest;
    if (plan === null) return;
    const gen = generation;
    servedGen = gen;
    let done = 0;
    for (const id of plan.episodeIds) {
      if (gen !== generation) break; // 被新计划取代：外层换成新计划重来
      if (existingMediaAny(id, getSettings().enhanceVideo, plan.hevc) !== null) continue;
      const job = await startUpgradeJob(id, plan.quality, plan.hevc).catch(() => null);
      if (job === null) continue;
      done += 1;
      // 串行：等这一集真的转好（或失败）再开下一集，别和正在播的那集抢 CPU
      while (gen === generation) {
        const now = getJob(job.id);
        if (now === undefined || now.state === 'ready' || now.state === 'failed') break;
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    if (gen === generation) {
      log.info(`预加载完成（世代 ${gen}，处理 ${done} 集 / 计划 ${plan.episodeIds.length} 集）`);
      return;
    }
  }
}

/** 当前是否还有预加载任务在跑（诊断用） */
export function preloadBusy(): boolean {
  return running;
}
