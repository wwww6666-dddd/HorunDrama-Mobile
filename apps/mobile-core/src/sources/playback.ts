/**
 * 取流：把 SDK 的播放模型收敛成"一个能播的地址 + 解密信息"。
 *
 * App 源给的是 HEVC + CENC 加密流，浏览器放不了；
 * 所以这里只负责拿到 url / 解密 key / 时长，解码转码交给 media/transcode。
 */
import { getClient, withRetry } from './client.ts';
import { lastAppError, resolveAppStream } from './appplay.ts';
import { resolveHgStream } from './hgresolve.ts';
import { createLogger } from '../util/log.ts';

const log = createLogger('playback');

export interface StreamChoice {
  episodeId: string;
  definition: string;
  codec: string;
  width: number;
  height: number;
  url: string;
  /** 16 字节 hex；空串表示未加密 */
  decryptionKey: string;
  protected: boolean;
  durationSec: number;
  /** 这一集上游实际提供的清晰度（升序，用来渲染选择器） */
  available: string[];
}

function rankOf(definition: string | undefined): number {
  const m = /(\d+)/.exec(definition ?? '');
  return m?.[1] === undefined ? 0 : Number.parseInt(m[1], 10);
}

/**
 * 选流：
 *  - prefer 指定档位（480p/720p/1080p）时，优先同档，其次不高于它的最高档；
 *  - auto / 未指定：不超过 720p 的最高档（再高转码太慢，磁盘也吃不消）；
 *  - 没有 ≤720p 的档就取最低档，避免把 4K 拖去转码。
 */
function pickStream(streams: Array<{ definition?: string; url?: string }>, prefer = 'auto'): number {
  if (prefer !== '' && prefer !== 'auto') {
    const want = rankOf(prefer);
    let exact = -1;
    let bestBelow = -1;
    let bestBelowRank = -1;
    streams.forEach((s, i) => {
      const r = rankOf(s.definition);
      if (r <= 0) return;
      if (r === want) exact = i;
      if (r <= want && r > bestBelowRank) {
        bestBelowRank = r;
        bestBelow = i;
      }
    });
    if (exact >= 0) return exact;
    if (bestBelow >= 0) return bestBelow;
  }

  let best = -1;
  let bestRank = -1;
  streams.forEach((s, i) => {
    const r = rankOf(s.definition);
    if (r > 0 && r <= 720 && r > bestRank) {
      bestRank = r;
      best = i;
    }
  });
  if (best >= 0) return best;
  let lowest = 0;
  let lowestRank = Number.POSITIVE_INFINITY;
  streams.forEach((s, i) => {
    const r = rankOf(s.definition);
    if (r > 0 && r < lowestRank) {
      lowestRank = r;
      lowest = i;
    }
  });
  return lowest;
}

/**
 * 取一集的 App 源流。
 *
 * 优先走我们自己实现的 App 取流（sources/appplay.ts：每次新匿名身份 + 真签名，
 * 能拿到 360p~1080p 的 HEVC/CENC 片源 + 内容密钥）。SDK 那条路
 * （/novel/player/video_model/v1/ + 常驻匿名设备）现在会被上游软拦截成
 * 200 + 空 body，只作为兜底。
 *
 * attempts 默认 2（限流/空响应很常见，退避重试一次）。播放链路会传 1：
 * 官网 360p 直连已经很稳，App 源失败时应该立刻退化，而不是让用户干等重试。
 */
/**
 * 清晰度降级链：默认最高，上游没有该档就自动往下退。
 * 1080p → 720p → 480p → 360p；用户显式选低档时只退到该档以下。
 */
const QUALITY_CHAIN: Record<string, string[]> = {
  '1080p': ['1080p', '720p', '480p', '360p'],
  '720p': ['720p', '480p', '360p'],
  '480p': ['480p', '360p'],
  '360p': ['360p'],
  smooth: ['360p'],
};

export async function resolveEpisodeStream(
  episodeId: string,
  prefer = 'auto',
  attempts = 2,
): Promise<StreamChoice | null> {
  const tiers = QUALITY_CHAIN[prefer];
  if (tiers !== undefined) {
    for (let i = 0; i < tiers.length; i += 1) {
      const want = tiers[i] ?? '360p';
      // 优先走带 MetaSec v5/SDI 的侧车（2026-11-23 后旧纯 JS 签名会空响应）。
      // 360p 仍交给官网 H.264 直连，避免为了低清去转码 HEVC。
      const hg = want === '360p' ? null : await resolveHgStream(episodeId, want);
      // 中间档失败不计入熔断计数：这是"上游没有这一档"，不是限流
      const stream = hg ?? (await resolveAppStream(episodeId, want, i === tiers.length - 1));
      if (stream !== null) {
        if (rankOf(stream.definition) !== rankOf(want)) {
          log.info(`上游没有 ${want}，这一集实际拿到 ${stream.definition}`);
        }
        return stream;
      }
      // 整集只有 ByteVC2（H.266）这类硬限制，换档位也没用，别浪费四次请求
      if (/ByteVC2|H\.266|VVC/.test(lastAppError())) break;
    }
  } else {
    const hg = await resolveHgStream(episodeId, prefer);
    if (hg !== null) return hg;
    const direct = await resolveAppStream(episodeId, prefer);
    if (direct !== null) return direct;
  }

  const client = await getClient();
  const result = await withRetry('取流', () => client.resolvePlayback(episodeId), attempts);
  const streams = result.playback?.streams ?? [];
  if (streams.length === 0) return null;

  const chosen = streams[pickStream(streams, prefer)];
  if (chosen === undefined) return null;

  const available = [...new Set(streams.map((s) => s.definition ?? '').filter((d) => d !== ''))].sort(
    (a, b) => rankOf(a) - rankOf(b),
  );

  log.debug(
    `取流 ${episodeId}: ${chosen.definition ?? '?'}p ${chosen.codec ?? '?'} protected=${String(result.playback.protected)} prefer=${prefer} available=${available.join(',')}`,
  );

  return {
    episodeId,
    definition: chosen.definition ?? '原画',
    codec: chosen.codec ?? 'bytevc1',
    width: chosen.width ?? 0,
    height: chosen.height ?? 0,
    url: chosen.url ?? '',
    decryptionKey: result.contentKey?.key ?? '',
    protected: result.playback.protected === true,
    durationSec: result.playback.duration_seconds ?? 0,
    available,
  };
}
