const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

async function startCore(t) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const tempRoot = process.env.HORUN_TEST_TMP ?? path.resolve(__dirname, '..', '..', '..', '..', '.tmp', 'core-tests');
  fs.mkdirSync(tempRoot, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(tempRoot, 'http-'));
  const child = spawn(process.execPath, ['src/index.ts'], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: { ...process.env, HORUN_PORT: String(port), HORUN_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  // 别再匹配启动日志文案（改一次文案就挂，D-08）：直接轮询 /api/health。
  await waitForHealth(port, child, () => output, 15_000);
  t.after(async () => {
    if (child.exitCode === null) {
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill();
      });
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { child, port };
}

/** 轮询 /api/health 直到核心能正常应答；比匹配日志文案稳，也不依赖日志格式。 */
async function waitForHealth(port, child, getOutput, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`core exited early: ${child.exitCode}\n${getOutput()}`);
    }
    try {
      const body = await getJson(port, '/api/health');
      if (body.ok === true) return;
      lastError = new Error(`health not ok: ${JSON.stringify(body).slice(0, 200)}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`core did not become healthy in ${timeoutMs}ms: ${lastError?.message ?? 'timeout'}\n${getOutput()}`);
}

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers: { accept: 'application/json' } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.once('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`non-JSON response (${res.statusCode}): ${data.slice(0, 200)}`));
        }
      });
      res.once('error', reject);
    });
    req.once('error', reject);
  });
}

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject);
  });
}

test('malformed static path returns 400 and leaves core alive', async (t) => {
  const { child, port } = await startCore(t);
  assert.equal(await request(port, '/%'), 400);
  assert.equal(child.exitCode, null);
});

test('malformed HTTP request receives 400 and leaves core alive', async (t) => {
  const { child, port } = await startCore(t);
  const response = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.setTimeout(3000);
    socket.on('connect', () => socket.write('GET / HTTP/1.1\r\nBad Header\r\n\r\n'));
    socket.on('data', (chunk) => { data += chunk.toString(); });
    socket.on('end', () => resolve(data));
    socket.on('timeout', () => reject(new Error('HTTP error response timed out')));
    socket.on('error', reject);
  });
  assert.match(response, /^HTTP\/1\.1 400/m);
  assert.match(response, /"code":"bad_request"/);
  assert.equal(child.exitCode, null);
});
