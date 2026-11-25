/**
 * 签名服务（hgsigner）：登录、评论、点赞这些要签名的接口靠它。
 *
 * 电脑端优先复用/拉起 PC 版同一个 hgsigner.exe；
 * 独立 APK 没有 Windows 可执行文件，改为在 Node 核心内启动纯 JS 签名服务。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './log.ts';
import { startLocalSigner, stopLocalSigner } from './signer-js.ts';

const log = createLogger('signer');
const PORT = 8791;

let proc: ChildProcess | null = null;

function candidates(): string[] {
  return [
    process.env.HORUN_SIGNER_EXE ?? '',
    path.resolve(import.meta.dirname, '../../resources/hgsigner/hgsigner.exe'),
  ].filter((p) => p !== '');
}

async function alive(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(1500),
    });
    // 400/500 也算活着：只要端口有人应答
    return res.status < 600;
  } catch {
    return false;
  }
}

export async function startSigner(): Promise<void> {
  process.env.YIMU_SIGNER_URL = `http://127.0.0.1:${PORT}/sign`;
  process.env.HORUN_SIGNER_URL = process.env.YIMU_SIGNER_URL;
  if (await alive()) {
    log.info(`签名服务已在 ${PORT} 运行，直接复用`);
    return;
  }

  // Android 没有 hgsigner.exe；独立 APK 必须在手机内完成签名。
  if (process.platform === 'android' || process.env.HORUN_SIGNER_INPROCESS === '1') {
    await startLocalSigner(PORT);
    return;
  }

  const exe = candidates().find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  if (exe === undefined) {
    log.warn('没找到 hgsigner.exe，改用纯 JS 签名');
    await startLocalSigner(PORT);
    return;
  }
  try {
    proc = spawn(exe, ['-addr', `127.0.0.1:${PORT}`], { stdio: 'ignore', windowsHide: true });
    proc.on('error', (err) => log.warn(`签名服务启动失败：${err.message}`));
    log.info(`签名服务已启动：${exe}`);
  } catch (err) {
    log.warn(`签名服务启动失败：${(err as Error).message}`);
  }
}

export function stopSigner(): void {
  proc?.kill();
  proc = null;
  stopLocalSigner();
}
