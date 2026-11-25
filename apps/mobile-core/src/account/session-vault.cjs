const crypto = require('node:crypto');

function serializeSessionFile(value, key) {
  if (key === '') return JSON.stringify(value, null, 2);
  const secret = decodeKey(key);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secret, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({
    format: 'horun-session-v1',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  });
}

function parseSessionFile(contents, key) {
  const parsed = JSON.parse(contents);
  if (parsed?.format !== 'horun-session-v1') return { value: parsed, encrypted: false };
  const secret = decodeKey(key);
  const decipher = crypto.createDecipheriv('aes-256-gcm', secret, Buffer.from(parsed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(parsed.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return { value: JSON.parse(plain), encrypted: true };
}

function decodeKey(key) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/i.test(key)) {
    throw new Error('会话加密密钥缺失或格式无效');
  }
  return Buffer.from(key, 'hex');
}

module.exports = { parseSessionFile, serializeSessionFile };
