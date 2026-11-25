/**
 * HorunDrama 手机端核心入口。
 *
 * 跑在 PC 上，绑 0.0.0.0，手机通过局域网访问；同时托管手机端前端产物。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { HOST, PORT, DATA_ROOT, VERSION, WEB_DIST, LAN, lanAddresses } from './config.ts';
import { Router } from './http/router.ts';
import { registerRoutes } from './http/api.ts';
import { startSigner, stopSigner } from './util/signer.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function serveStatic(res: http.ServerResponse, pathname: string): void {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    const body = '{"ok":false,"code":"bad_url","message":"请求地址编码无效"}';
    res.writeHead(400, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    res.end(body);
    return;
  }
  const resolved = path.resolve(WEB_DIST, rel);
  const inside = resolved === WEB_DIST || resolved.startsWith(WEB_DIST + path.sep);
  const wantFile = rel !== '' && path.extname(resolved) !== '';
  const file = inside && wantFile && fs.existsSync(resolved) ? resolved : path.join(WEB_DIST, 'index.html');

  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('前端还没构建：pnpm --filter @horun/mobile-web run build');
    return;
  }

  const stat = fs.statSync(file);
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': path.extname(file).toLowerCase() === '.html' ? 'no-store' : 'public, max-age=3600',
  });
  fs.createReadStream(file).pipe(res);
}

const router = new Router();
registerRoutes(router);
const apiToken = process.env.HORUN_API_TOKEN ?? '';
const selfHost = `${HOST}:${PORT}`.toLowerCase();
/** 局域网模式不校验 Host/Origin：手机是用 http://<电脑IP>:<端口> 访问的，来源必然不同 */
const allowedOrigins: Set<string> | null = LAN ? null : new Set([`http://${HOST}:${PORT}`]);
const allowedHosts: Set<string> | null = LAN ? null : new Set([selfHost]);
if (process.env.HORUN_DEV === '1') {
  allowedOrigins?.add('http://127.0.0.1:5274');
  allowedOrigins?.add('http://localhost:5274');
  allowedHosts?.add('127.0.0.1:5274');
  allowedHosts?.add('localhost:5274');
}

function authorized(req: http.IncomingMessage): boolean {
  if (apiToken === '') return true;
  const cookie = req.headers.cookie ?? '';
  const cookieToken = cookie.match(/(?:^|;\s*)horun_token=([^;]+)/)?.[1] ?? '';
  const headerToken = req.headers['x-horun-token'];
  const supplied = typeof headerToken === 'string' ? headerToken : cookieToken;
  const expected = Buffer.from(apiToken);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const server = http.createServer((req, res) => {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end('{"ok":false,"code":"bad_url","message":"请求地址无效"}');
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    if (allowedHosts !== null && !allowedHosts.has((req.headers.host ?? '').toLowerCase())) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end('{"ok":false,"code":"bad_host","message":"拒绝非本机 Host"}');
      return;
    }
    const origin = req.headers.origin;
    if (allowedOrigins !== null && origin !== undefined && !allowedOrigins.has(origin)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end('{"ok":false,"code":"bad_origin","message":"拒绝跨来源请求"}');
      return;
    }
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end('{"ok":false,"code":"unauthorized","message":"缺少有效的本机应用令牌"}');
      return;
    }
    let hit;
    try {
      hit = router.match(method, url.pathname);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end('{"ok":false,"code":"bad_url","message":"请求地址编码无效"}');
      return;
    }
    if (hit === null) {
      const body = JSON.stringify({ ok: false, code: 'no_route', message: `没有这个接口: ${url.pathname}` });
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    void Promise.resolve(hit.handler({ req, res, url, params: hit.params })).catch((err: unknown) => {
      if (!res.headersSent) {
        const body = JSON.stringify({ ok: false, code: 'internal', message: (err as Error).message });
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(body);
      } else {
        res.end();
      }
    });
    return;
  }

  serveStatic(res, url.pathname);
});

server.on('clientError', (_err, socket) => {
  if (!socket.writable) return;
  const body = '{"ok":false,"code":"bad_request","message":"HTTP 请求格式无效"}';
  socket.end(
    `HTTP/1.1 400 Bad Request\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
});

server.on('error', (err) => {
  console.error('[core] 启动失败:', err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  fs.mkdirSync(path.join(DATA_ROOT, 'cache', 'images'), { recursive: true });
  console.log(`[core] HorunDrama 手机端核心 v${VERSION} → http://${HOST}:${PORT}`);
  console.log(`[core] 数据目录: ${DATA_ROOT}`);
  console.log(`[core] 前端产物: ${fs.existsSync(WEB_DIST) ? WEB_DIST : '（未构建）'}`);
  if (LAN) {
    const ips = lanAddresses();
    if (ips.length === 0) {
      console.log('[core] 没找到局域网地址：确认电脑已连 Wi-Fi/网线');
    } else {
      console.log('[core] 手机端访问地址（APK 里填这个）:');
      for (const ip of ips) console.log(`        http://${ip}:${PORT}`);
    }
  }
  console.log(`[core] 本机调试: http://127.0.0.1:${PORT}`);
  void startSigner();
});

const shutdown = (): void => {
  stopSigner();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
