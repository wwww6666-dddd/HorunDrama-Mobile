/**
 * 极简 CDP 客户端：用系统自带的 Edge 跑真实浏览器，驱动点击 + 截图 + 取值。
 * 只用于本地自测，不参与构建。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(fn, timeoutMs = 20000, label = 'condition') {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await sleep(150);
  }
  throw new Error(`等待超时: ${label}${lastErr ? ` (${lastErr.message})` : ''}`);
}

export class Browser {
  constructor(proc, ws, send) {
    this.proc = proc;
    this.ws = ws;
    this.send = send;
    this.nextId = 1;
  }

  static async launch({ port = 9333, userDataDir, width = 1600, height = 1000 } = {}) {
    const dir = userDataDir ?? path.resolve('.tmp/cdp-profile');
    fs.mkdirSync(dir, { recursive: true });
    const proc = spawn(
      EDGE,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--mute-audio',
        '--autoplay-policy=no-user-gesture-required',
        `--window-size=${width},${height}`,
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${dir}`,
        'about:blank',
      ],
      { stdio: 'ignore' },
    );

    const version = await waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      return res.ok ? res.json() : null;
    }, 15000, 'browser debug endpoint');

    const targets = await waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      return list.find((t) => t.type === 'page') ?? null;
    }, 15000, 'page target');

    const ws = new WebSocket(targets.webSocketDebuggerUrl);
    const pending = new Map();
    let id = 1;
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const myId = id++;
        pending.set(myId, { resolve, reject });
        ws.send(JSON.stringify({ id: myId, method, params }));
      });

    await send('Page.enable');
    await send('Runtime.enable');
    const browser = new Browser(proc, ws, send);
    browser.debugUrl = version.webSocketDebuggerUrl;
    return browser;
  }

  /** 连到已经在跑、且开了 --remote-debugging-port 的浏览器（例如 Electron 窗口）。 */
  static async attach(port = 9333) {
    const targets = await waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      return list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://')) ?? null;
    }, 30000, 'electron page target');

    const ws = new WebSocket(targets.webSocketDebuggerUrl);
    const pending = new Map();
    let id = 1;
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const myId = id++;
        pending.set(myId, { resolve, reject });
        ws.send(JSON.stringify({ id: myId, method, params }));
      });
    await send('Page.enable');
    await send('Runtime.enable');
    const browser = new Browser({ kill: () => ws.close() }, ws, send);
    browser.attachedUrl = targets.url;
    return browser;
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    await sleep(400);
  }

  async eval(expression, { awaitPromise = false } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? 'eval failed');
    return res.result?.value;
  }

  async click(selector) {
    const ok = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!ok) throw new Error(`点击失败，找不到 ${selector}`);
  }

  async shot(file) {
    const res = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    return file;
  }

  async close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
    this.proc.kill();
  }
}
