const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseSessionFile, serializeSessionFile } = require('./session-vault.cjs');

test('encrypts session data and round-trips it with the same key', () => {
  const key = Buffer.alloc(32, 7).toString('hex');
  const value = { cookie: 'sessionid=private-cookie', token: 'private-token' };
  const encoded = serializeSessionFile(value, key);

  assert.doesNotMatch(encoded, /private-cookie|private-token/);
  assert.deepEqual(parseSessionFile(encoded, key), { value, encrypted: true });
});

test('rejects encrypted session data when the key is wrong', () => {
  const encoded = serializeSessionFile({ cookie: 'secret' }, Buffer.alloc(32, 1).toString('hex'));
  assert.throws(() => parseSessionFile(encoded, Buffer.alloc(32, 2).toString('hex')));
});

test('reads legacy plain session JSON so the caller can migrate it', () => {
  const legacy = JSON.stringify({ cookie: 'old-session', profile: { loggedIn: true } });
  assert.deepEqual(parseSessionFile(legacy, ''), {
    value: { cookie: 'old-session', profile: { loggedIn: true } },
    encrypted: false,
  });
});

test('core migrates a legacy session file to encrypted storage on first read', (t) => {
  const tempRoot = process.env.HORUN_TEST_TMP ?? path.resolve(__dirname, '..', '..', '..', '..', '.tmp', 'core-tests');
  fs.mkdirSync(tempRoot, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(tempRoot, 'session-migration-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const legacy = {
    cookie: 'sessionid=legacy-private-cookie',
    token: 'legacy-private-token',
    profile: { userId: '42', nickname: 'Legacy', avatar: '', loggedIn: true },
    savedAt: 123,
    source: 'manual',
  };
  const sessionFile = path.join(dataDir, 'session.json');
  fs.writeFileSync(sessionFile, JSON.stringify(legacy));
  const key = Buffer.alloc(32, 5).toString('hex');
  const script = "import { readSession } from './src/account/session.ts'; process.stdout.write(JSON.stringify(readSession()))";
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: { ...process.env, HORUN_DATA_DIR: dataDir, HORUN_SESSION_KEY: key },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), legacy);
  const persisted = fs.readFileSync(sessionFile, 'utf8');
  assert.doesNotMatch(persisted, /legacy-private-cookie|legacy-private-token/);
  assert.equal(JSON.parse(persisted).format, 'horun-session-v1');
});
