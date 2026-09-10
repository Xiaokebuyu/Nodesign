/**
 * server/runtime/components-fetch.js — 组件的「把远端的东西弄到盘上」那一半（2026-09-10 从 components.js 拆出）。
 *
 * 拆的理由是行数棘轮：components.js 顶到 600 了。挑这一段走是因为它跟"管理"是两件事 ——
 * 这里只管**选源 / 测速 / 下载 / 解压**，不知道有哪些组件、装在哪、谁在用；
 * components.js 那边才管清单、已装状态、装卸、位置、env。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';

/**
 * 镜像（站主 09-06：GitHub 在国内经常"通但只有几十 KB/s"）。每个镜像是一个目录前缀，里面按文件名放同一批资产
 * （manifest.json 和各个 zip），server/scripts/sync-components-mirror.sh 从 release 同步过去。
 * 清单自己的 mirrors 字段优先，其次 env NODESIGN_COMPONENTS_MIRRORS（逗号分隔），最后这份内置默认。
 */
export const DEFAULT_MIRRORS = ['https://nodesign.xiaobuyu.trade/dl/components-win64'];
const PROBE_BYTES = 512 * 1024;
const PROBE_TIMEOUT_MS = 8000;
/** 官方能通且吞吐不低于最快镜像的这个比例就用官方（官方永远是最新版，镜像可能落后） */
const OFFICIAL_KEEP_RATIO = 1 / 3;

export function envMirrors() {
  return (process.env.NODESIGN_COMPONENTS_MIRRORS || '').split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean);
}

/** 这个资产所有可下的地址：官方在前，镜像按清单 → env → 内置的顺序 */
export function sourcesFor(def, manifest) {
  const file = def.url.split('/').pop();
  const mirrors = [...(Array.isArray(manifest?.mirrors) ? manifest.mirrors : []), ...envMirrors(), ...DEFAULT_MIRRORS]
    .map((m) => String(m).replace(/\/+$/, ''));
  const out = [{ kind: 'official', url: def.url }];
  for (const m of [...new Set(mirrors)]) out.push({ kind: 'mirror', url: `${m}/${file}` });
  return out;
}

/** 拉前 512KB 测吞吐（Range）。不通 / 超时 → ok:false。不支持 Range 的源会把整个文件发过来，读够就断 */
export async function probeSource(url, { bytes = PROBE_BYTES, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { range: `bytes=0-${bytes - 1}` }, signal: ctrl.signal });
    if (!res.ok || !res.body) return { ok: false, error: `HTTP ${res.status}` };
    const reader = res.body.getReader();
    let got = 0;
    while (got < bytes) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
    }
    try { await reader.cancel(); } catch { /* */ }
    const ms = Math.max(1, Date.now() - t0);
    return { ok: got > 0, bytes: got, ms, bytesPerSec: Math.round((got / ms) * 1000) };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? `${timeoutMs / 1000}s 没响应` : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 选源：所有候选并行测速。官方能通、且吞吐不低于最快镜像的 OFFICIAL_KEEP_RATIO 就用官方（永远最新）；
 * 否则最快的那个能通的镜像；一个都不通就还是官方（让下载那步报真实的错）。
 */
export async function pickSource(sourcesOrDef, manifest) {
  const sources = Array.isArray(sourcesOrDef) ? sourcesOrDef : sourcesFor(sourcesOrDef, manifest);
  const results = await Promise.all(sources.map(async (s) => ({ ...s, probe: await probeSource(s.url) })));
  const officials = results.filter((r) => r.kind === 'official' && r.probe.ok).sort((a, b) => b.probe.bytesPerSec - a.probe.bytesPerSec);
  const mirrorsOk = results.filter((r) => r.kind !== 'official' && r.probe.ok).sort((a, b) => b.probe.bytesPerSec - a.probe.bytesPerSec);
  const official = officials[0] || null;
  const best = mirrorsOk[0] || null;
  let chosen;
  if (official && (!best || official.probe.bytesPerSec >= best.probe.bytesPerSec * OFFICIAL_KEEP_RATIO)) chosen = official;
  else chosen = best || results[0];
  return { chosen, results };
}

/**
 * 下载到文件：流式、边下边算 sha256、按 content-length 报进度。
 * ⚠️ 报错要带地址和状态码 —— 装失败时用户看到的就是这一句，别再发生"退出码 1"那种什么都没说的报错。
 */
export async function downloadFile(url, dest, { onProgress = null, timeoutMs = 6 * 60 * 60 * 1000 } = {}) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(`下载 ${url} 失败：${err.cause?.message || err.message}`);
  }
  if (!res.ok || !res.body) throw new Error(`下载 ${url} 失败：HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || null;
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const out = fs.createWriteStream(dest);
  const meter = new Writable({
    write(chunk, _enc, cb) {
      hash.update(chunk); bytes += chunk.length;
      onProgress?.(bytes, total);
      out.write(chunk, cb);
    },
    final(cb) { out.end(cb); },
  });
  try {
    await pipeline(res.body, meter);
  } catch (err) {
    fs.rmSync(dest, { force: true });
    throw new Error(`下载 ${url} 中断在 ${Math.round(bytes / 1048576)}MB${total ? ` / ${Math.round(total / 1048576)}MB` : ''}：${err.cause?.message || err.message}`);
  }
  if (total && bytes !== total) { fs.rmSync(dest, { force: true }); throw new Error(`下载 ${url} 不完整：${bytes} / ${total} 字节`); }
  return { sha256: hash.digest('hex'), bytes, total };
}

/** 测试用 */


export function readZipModes(zipPath) {
  const modes = new Map();
  const fd = fs.openSync(zipPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 0xffff + 22 + 20);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) return modes;
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOff = tail.readUInt32LE(eocd + 16);
    if (cdSize === 0xffffffff || cdOff === 0xffffffff || tail.readUInt16LE(eocd + 10) === 0xffff) {
      const loc = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]), eocd);   // zip64 EOCD locator
      if (loc < 0) return modes;
      const z64Off = Number(tail.readBigUInt64LE(loc + 8));
      const z64 = Buffer.alloc(56);
      fs.readSync(fd, z64, 0, 56, z64Off);
      if (z64.readUInt32LE(0) !== 0x06064b50) return modes;
      cdSize = Number(z64.readBigUInt64LE(40));
      cdOff = Number(z64.readBigUInt64LE(48));
    }
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    let i = 0;
    while (i + 46 <= cd.length && cd.readUInt32LE(i) === 0x02014b50) {
      const os = cd[i + 5];
      const nameLen = cd.readUInt16LE(i + 28), extraLen = cd.readUInt16LE(i + 30), commentLen = cd.readUInt16LE(i + 32);
      const attrs = cd.readUInt32LE(i + 38);
      const name = cd.toString('utf8', i + 46, i + 46 + nameLen);
      const mode = os === 3 ? (attrs >>> 16) & 0o7777 : 0;
      if (mode) modes.set(name, mode);
      i += 46 + nameLen + extraLen + commentLen;
    }
  } finally {
    fs.closeSync(fd);
  }
  return modes;
}

/** 流式解压 zip 到 dest；strip = 剥掉前几层目录（上游 zip 常带一层 name-version/） */
export async function extractZip(zipPath, dest, strip = 0) {
  let modes = null;
  if (process.platform !== 'win32') {
    try { modes = readZipModes(zipPath); } catch (err) { console.warn(`[components] 读不到 ${path.basename(zipPath)} 的权限位：${err.message}`); }
  }
  return new Promise((resolve, reject) => {
    const unzip = new Unzip();
    unzip.register(UnzipInflate);
    unzip.register(UnzipPassThrough);   // method 0（stored）：小文件常是这个，不注册就 "no stream handler"
    const pending = new Set();
    let failed = null;
    const fail = (err) => { if (!failed) { failed = err; reject(err); } };
    unzip.onfile = (file) => {
      const rel = file.name.split('/').filter(Boolean).slice(strip).join('/');
      // 不 start() 的条目 fflate 直接跳过（start 前必须先挂 ondata，不然它抛 no stream handler）
      if (!rel || rel.split('/').some((seg) => seg === '..')) return;   // 目录项 / 越界路径
      const target = path.join(dest, rel);
      if (!path.resolve(target).startsWith(path.resolve(dest) + path.sep)) return;
      if (file.name.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); return; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const ws = fs.createWriteStream(target);
      // unix 权限位在 zip 的外部属性高 16 位（os=3 才是 unix 那套）。不带出来的话 chrome 旁边的
      // chrome_crashpad_handler / chrome_sandbox 全没 +x，浏览器一起就死（09-07 在 arm64 上对照 playwright 自己解的那份逮到的）
      const mode = modes?.get(file.name) || 0;
      const p = new Promise((res, rej) => {
        ws.on('finish', () => {
          if (mode && process.platform !== 'win32') { try { fs.chmodSync(target, mode); } catch { /* */ } }
          res();
        });
        ws.on('error', rej);
      });
      pending.add(p);
      file.ondata = (err, chunk, final) => {
        if (err) { ws.destroy(err); fail(err); return; }
        if (chunk && chunk.length) ws.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length));
        if (final) ws.end();
      };
      file.start();
    };
    const rs = fs.createReadStream(zipPath, { highWaterMark: 1 << 20 });
    rs.on('data', (c) => { try { unzip.push(new Uint8Array(c.buffer, c.byteOffset, c.length), false); } catch (err) { fail(err); rs.destroy(); } });
    rs.on('error', fail);
    rs.on('end', () => {
      try { unzip.push(new Uint8Array(0), true); } catch (err) { fail(err); return; }
      Promise.all(pending).then(() => { if (!failed) resolve(); }).catch(fail);
    });
  });
}

