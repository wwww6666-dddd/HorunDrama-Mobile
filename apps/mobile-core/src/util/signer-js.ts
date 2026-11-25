/**
 * 纯 JS 签名服务：独立 APK 里没有 hgsigner.exe，登录/评论/点赞改由本进程签。
 *
 * 接口与 hgsigner 对齐：POST /sign，请求 { path, query, body, deviceId, version }，
 * 返回 { query, headers }。签名算法直接复用 App 取流那套 pure-sign，
 * 不再依赖任何 Windows 可执行文件。
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createLogger } from './log.ts';

const log = createLogger('signer-js');
const require = createRequire(import.meta.url);
const PureSign = require('../upstream/hongguoweb/core/pure-sign.js') as {
  sign: (url: string, body: string, khronos?: number) => Record<string, string>;
};

interface SignRequest {
  path?: string;
  query?: Array<[string, string]>;
  body?: string;
  deviceId?: string;
  version?: string;
}

let server: http.Server | null = null;

function pairsToQuery(pairs: Array<[string, string]>): string {
  const params = new URLSearchParams();
  for (const [key, value] of pairs) params.append(key, String(value));
  return params.toString();
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 2 * 1024 * 1024) throw new Error('请求体过大');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url ?? '/';
  if (url === '/healthz') {
    json(res, 200, { ok: true, mode: 'in-process' });
    return;
  }
  if (url !== '/sign') {
    json(res, 404, { ok: false, message: 'not found' });
    return;
  }
  if (req.method !== 'POST') {
    json(res, 405, { ok: false, message: 'POST required' });
    return;
  }
  void readBody(req)
    .then((text) => {
      const input = JSON.parse(text) as SignRequest;
      const pathname = typeof input.path === 'string' ? input.path : '/';
      const body = typeof input.body === 'string' ? input.body : '';
      const query = pairsToQuery(Array.isArray(input.query) ? input.query : []);
      const target = `https://horun.local${pathname}?${query}`;
      const headers = { ...PureSign.sign(target, body) };
      // 账号接口的公共头；hgsigner 也会补这两项。纯 JS 路径显式补上，避免上游 200 空包。
      headers['x-ss-dp'] = '8662';
      if (body !== '') headers['x-ss-stub'] = crypto.createHash('md5').update(body).digest('hex').toUpperCase();
      json(res, 200, { query, headers });
    })
    .catch((err: unknown) => {
      log.warn(`签名失败：${(err as Error).message}`);
      json(res, 400, { ok: false, message: (err as Error).message });
    });
}

export function startLocalSigner(port = 8791): Promise<void> {
  if (server !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = http.createServer(handle);
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => {
      s.off('error', reject);
      server = s;
      log.info(`纯 JS 签名服务已启动：127.0.0.1:${port}`);
      resolve();
    });
  });
}

export function stopLocalSigner(): void {
  server?.close();
  server = null;
}
