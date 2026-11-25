/**
 * 根目录 `pnpm dev` 的入口（D-09：此前 package.json 指向不存在的脚本）。
 *
 * 同时起两个进程：
 *   1. mobile-core（Node 直跑 TS，监听 5881）
 *   2. mobile-web 的 Vite dev server（5274，/api 代理到 5881）
 *
 * 核心侧带 HORUN_DEV=1，否则它会拒绝来自 5274 的跨源请求。
 * 任意一个退出就一起收掉另一个 —— 留一个孤儿进程占着端口，下次启动必冲突。
 */
import { spawn } from 'node:child_process';

const isWin = process.platform === 'win32';
const pnpm = isWin ? 'pnpm.cmd' : 'pnpm';

const children = [];
let shuttingDown = false;

function run(args, extraEnv = {}) {
  const child = spawn(pnpm, args, {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...extraEnv },
  });
  children.push(child);
  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.log(`[dev] 子进程退出（${args.join(' ')}，code=${code ?? 'null'}），一起收尾`);
      shutdown(code ?? 0);
    }
  });
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
    }
  }
  // 给子进程一点时间自行清理（Node 核心要关 SQLite / 签名服务）
  setTimeout(() => process.exit(code), 1200);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('[dev] 核心 → http://127.0.0.1:5881，前端 → http://127.0.0.1:5274');
run(['--filter', '@horun/mobile-core', 'run', 'dev'], { HORUN_DEV: '1' });
run(['--filter', '@horun/mobile-web', 'run', 'dev']);
