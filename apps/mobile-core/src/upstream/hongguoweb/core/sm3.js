'use strict';
/**
 * SM3（国产哈希），带运行时降级。
 *
 * 为什么需要这个文件：Electron 自带的 Node 用 BoringSSL，`crypto.createHash('sm3')`
 * 直接抛 "Digest method not supported"；而 x-medusa 的签名链路离不开 SM3。
 * 普通 Node（OpenSSL）走原生实现，Electron 走下面的纯 JS 实现。
 * 纯 JS 版本已与 node:crypto 在空串/短文/长文/中文上逐字节对比通过。
 */
const crypto = require('crypto');

let native = true;
try {
  crypto.createHash('sm3');
} catch {
  native = false;
}

const IV = [0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e];
const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
const p0 = (x) => (x ^ rotl(x, 9) ^ rotl(x, 17)) >>> 0;
const p1 = (x) => (x ^ rotl(x, 15) ^ rotl(x, 23)) >>> 0;
const ff = (x, y, z, j) => (j < 16 ? (x ^ y ^ z) >>> 0 : ((x & y) | (x & z) | (y & z)) >>> 0);
const gg = (x, y, z, j) => (j < 16 ? (x ^ y ^ z) >>> 0 : ((x & y) | (~x & z)) >>> 0);
const tj = (j) => (j < 16 ? 0x79cc4519 : 0x7a879d8a);

function sm3Js(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const len = bytes.length;
  const bitLen = len * 8;
  const total = Math.ceil((len + 1 + 8) / 64) * 64;
  const buf = Buffer.alloc(total);
  bytes.copy(buf, 0);
  buf[len] = 0x80;
  buf.writeUInt32BE(Math.floor(bitLen / 0x100000000), total - 8);
  buf.writeUInt32BE(bitLen >>> 0, total - 4);

  const v = IV.slice();
  const w = new Array(68);
  const w1 = new Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = buf.readUInt32BE(off + i * 4);
    for (let j = 16; j < 68; j += 1) {
      w[j] = (p1((w[j - 16] ^ w[j - 9] ^ rotl(w[j - 3], 15)) >>> 0) ^ rotl(w[j - 13], 7) ^ w[j - 6]) >>> 0;
    }
    for (let j = 0; j < 64; j += 1) w1[j] = (w[j] ^ w[j + 4]) >>> 0;
    let [a, b, c, d, e, f, g, h] = v;
    for (let j = 0; j < 64; j += 1) {
      const ss1 = rotl(((rotl(a, 12) + e + rotl(tj(j), j % 32)) >>> 0) >>> 0, 7);
      const ss2 = (ss1 ^ rotl(a, 12)) >>> 0;
      const tt1 = (ff(a, b, c, j) + d + ss2 + w1[j]) >>> 0;
      const tt2 = (gg(e, f, g, j) + h + ss1 + w[j]) >>> 0;
      d = c;
      c = rotl(b, 9);
      b = a;
      a = tt1;
      h = g;
      g = rotl(f, 19);
      f = e;
      e = p0(tt2);
    }
    v[0] = (v[0] ^ a) >>> 0;
    v[1] = (v[1] ^ b) >>> 0;
    v[2] = (v[2] ^ c) >>> 0;
    v[3] = (v[3] ^ d) >>> 0;
    v[4] = (v[4] ^ e) >>> 0;
    v[5] = (v[5] ^ f) >>> 0;
    v[6] = (v[6] ^ g) >>> 0;
    v[7] = (v[7] ^ h) >>> 0;
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 8; i += 1) out.writeUInt32BE(v[i] >>> 0, i * 4);
  return out;
}

function sm3(input) {
  return native ? crypto.createHash('sm3').update(input).digest() : sm3Js(input);
}

module.exports = { sm3, sm3Js, hasNativeSm3: native };
