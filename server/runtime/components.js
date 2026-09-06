/**
 * server/runtime/components.js — 本地分发版的组件管理器（09-06，站主定的"首启引导页下载"那条路）。
 *
 * 组件 = 安装包里不带、按需下载到 <dataRoot>/components/<id>/ 的外部程序：git、ffmpeg、poppler、LibreOffice、
 * rembg 环境、chromium。清单（叫什么、多大、从哪下、sha256、装完哪个目录进 PATH）不写死在代码里，从站点
 * 仓库一个固定 release 的 manifest.json 读（COMPONENTS_MANIFEST_URL），换组件版本不用发应用。
 *
 * 装一个组件 = 下载（流式，边下边算 sha256，进度按 content-length）→ 校验 → 解压（fflate 流式，400MB 的
 * LibreOffice 也不进内存）→ 按清单把 bin 目录算成绝对路径写进 <id>.json → 把目录挂进 PATH → 重探能力表。
 * chromium 特殊：交给 playwright 自己的安装器（PLAYWRIGHT_BROWSERS_PATH 指进组件目录）。
 *
 * 状态全在内存里一张表（前端轮询 GET /api/local/components），进程重启后按磁盘上的 <id>.json 认"装了没"。
 * 只在 local profile 有意义；hosted 下 listComponents 返回空。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';
import { profile } from './profile.js';

export const COMPONENTS_MANIFEST_URL = process.env.NODESIGN_COMPONENTS_MANIFEST
  || 'https://github.com/Xiaokebuyu/Nodesign/releases/download/components-win64/manifest.json';
const MANIFEST_TTL_MS = 60 * 60 * 1000;

export const componentsRoot = profile.isLocal ? path.join(profile.dataRoot, 'components') : null;
const platformKey = `${process.platform}-${process.arch}`;

let manifestCache = { at: 0, manifest: null, error: null };
/** id → { status: 'idle'|'downloading'|'verifying'|'extracting'|'installing'|'done'|'error', progress, bytes, total, error } */
const jobs = new Map();

// ── 清单 ──

export async function loadManifest({ force = false } = {}) {
  if (!force && manifestCache.manifest && Date.now() - manifestCache.at < MANIFEST_TTL_MS) return manifestCache.manifest;
  try {
    let manifest;
    if (/^https?:/.test(COMPONENTS_MANIFEST_URL)) {
      const res = await fetch(COMPONENTS_MANIFEST_URL, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      manifest = await res.json();
    } else {
      manifest = JSON.parse(fs.readFileSync(COMPONENTS_MANIFEST_URL, 'utf8'));
    }
    if (!manifest?.components || typeof manifest.components !== 'object') throw new Error('manifest 没有 components');
    manifestCache = { at: Date.now(), manifest, error: null };
  } catch (err) {
    manifestCache = { ...manifestCache, error: err.message };
    if (!manifestCache.manifest) console.warn(`[components] 清单拉不到（${COMPONENTS_MANIFEST_URL}）：${err.message}`);
  }
  return manifestCache.manifest;
}

/** 测试用 */
export function _resetComponents() { manifestCache = { at: 0, manifest: null, error: null }; jobs.clear(); }

// ── 已装状态（磁盘） ──

function installedPath(id) { return path.join(componentsRoot, `${id}.json`); }
function dirOf(id) { return path.join(componentsRoot, id); }

export function readInstalled(id) {
  try { return JSON.parse(fs.readFileSync(installedPath(id), 'utf8')); } catch { return null; }
}

function listInstalledIds() {
  try { return fs.readdirSync(componentsRoot).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch { return []; }
}

/**
 * 装了的组件要给进程的东西：PATH 前缀目录 + 几个专用 env。起动时和每次装完都调一次。
 * @returns {{ binDirs: string[], env: Record<string,string> }}
 */
export function componentEnv() {
  const binDirs = []; const env = {};
  if (!componentsRoot) return { binDirs, env };
  for (const id of listInstalledIds()) {
    const rec = readInstalled(id);
    if (!rec) continue;
    for (const d of rec.binDirs || []) if (fs.existsSync(d)) binDirs.push(d);
    if (rec.python && fs.existsSync(rec.python)) env.NODESIGN_REMBG_PYTHON = rec.python;
    if (rec.modelsDir && fs.existsSync(rec.modelsDir)) env.U2NET_HOME = rec.modelsDir;
    if (rec.browsersPath) env.PLAYWRIGHT_BROWSERS_PATH = rec.browsersPath;
  }
  return { binDirs, env };
}

/** 把 componentEnv 写进 process.env（幂等：PATH 里已有的目录不重复加） */
export function applyComponentEnv() {
  const { binDirs, env } = componentEnv();
  const cur = (process.env.PATH || '').split(path.delimiter);
  const add = binDirs.filter((d) => !cur.includes(d));
  if (add.length) process.env.PATH = [...add, ...cur].join(path.delimiter);
  for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v;
  return { binDirs, env };
}

// ── 清单 + 状态 → 前端要的列表 ──

export async function listComponents() {
  if (!componentsRoot) return { platform: platformKey, manifestError: null, components: [] };
  const manifest = await loadManifest();
  const defs = manifest?.components || {};
  const out = Object.entries(defs).map(([id, def]) => {
    const installed = readInstalled(id);
    const job = jobs.get(id) || null;
    return {
      id, label: def.label || id, uses: def.uses || '', sizeMb: def.sizeMb || null, required: !!def.required, kind: def.kind || 'zip',
      supported: !def.platform || def.platform === platformKey,
      installed: !!installed, installedVersion: installed?.version || null,
      job,
    };
  });
  return { platform: platformKey, manifestError: manifestCache.error, components: out };
}

// ── 安装 ──

function setJob(id, patch) { jobs.set(id, { ...(jobs.get(id) || { status: 'idle', progress: 0 }), ...patch }); }

/** 装一个组件（幂等：正在装就返回现有任务；装完了且版本一样直接返回） */
export async function installComponent(id) {
  if (!componentsRoot) throw new Error('hosted profile 没有组件');
  const manifest = await loadManifest();
  const def = manifest?.components?.[id];
  if (!def) throw Object.assign(new Error(`清单里没有组件 ${id}`), { code: 'UNKNOWN_COMPONENT' });
  if (def.platform && def.platform !== platformKey) throw Object.assign(new Error(`组件 ${id} 只有 ${def.platform} 的包，这台是 ${platformKey}`), { code: 'UNSUPPORTED_PLATFORM' });
  const cur = jobs.get(id);
  if (cur && ['downloading', 'verifying', 'extracting', 'installing'].includes(cur.status)) return cur;
  fs.mkdirSync(componentsRoot, { recursive: true });
  setJob(id, { status: 'downloading', progress: 0, bytes: 0, total: null, error: null });
  // 不 await：调用方拿任务状态轮询
  (async () => {
    try {
      if (def.kind === 'playwright') await installPlaywright(id, def);
      else await installZip(id, def);
      applyComponentEnv();
      setJob(id, { status: 'done', progress: 1 });
    } catch (err) {
      console.error(`[components] 装 ${id} 失败：${err.message}`);
      setJob(id, { status: 'error', error: err.message });
      try { fs.rmSync(dirOf(id), { recursive: true, force: true }); } catch { /* */ }
    }
  })();
  return jobs.get(id);
}

async function installZip(id, def) {
  const dir = dirOf(id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(componentsRoot, `${id}.download`);

  // 下载 + sha256
  const res = await fetch(def.url, { signal: AbortSignal.timeout(6 * 60 * 60 * 1000) });
  if (!res.ok || !res.body) throw new Error(`下载 ${def.url} 失败：HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || null;
  setJob(id, { total });
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const out = fs.createWriteStream(tmp);
  const meter = new Writable({
    write(chunk, _enc, cb) {
      hash.update(chunk); bytes += chunk.length;
      setJob(id, { bytes, progress: total ? Math.min(0.85, (bytes / total) * 0.85) : 0.3 });
      out.write(chunk, cb);
    },
    final(cb) { out.end(cb); },
  });
  await pipeline(res.body, meter);
  const digest = hash.digest('hex');
  setJob(id, { status: 'verifying' });
  if (def.sha256 && digest !== String(def.sha256).toLowerCase()) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`校验失败：sha256 ${digest.slice(0, 12)}… ≠ 清单 ${String(def.sha256).slice(0, 12)}…（下载不完整或清单过期）`);
  }

  // 解压
  setJob(id, { status: 'extracting', progress: 0.88 });
  await extractZip(tmp, dir, def.strip || 0);
  fs.rmSync(tmp, { force: true });

  // bin 目录：清单写的是相对 dir 的 glob（一层通配够用：ffmpeg-*/bin）
  setJob(id, { status: 'installing', progress: 0.97 });
  const binDirs = (def.bin || []).map((g) => resolveGlobDir(dir, g)).filter(Boolean);
  const rec = { id, version: def.version || digest.slice(0, 12), sha256: digest, dir, binDirs, installedAt: new Date().toISOString() };
  if (def.python) rec.python = path.join(dir, def.python);
  if (def.modelsDir) rec.modelsDir = path.join(dir, def.modelsDir);   // rembg 的模型目录 → U2NET_HOME
  fs.writeFileSync(installedPath(id), JSON.stringify(rec, null, 2));
}

/**
 * playwright 自带安装器的路径。⛔ 不能 require.resolve('playwright/cli.js')：它的 package.json 用 exports 把
 * 子路径锁死了，只放行 "." 和 "./package.json"（09-06 站主在 Windows 引导页上第一个撞到的就是这条：
 * ERR_PACKAGE_PATH_NOT_EXPORTED）。从 package.json 反推目录再拼 cli.js。
 */
export function playwrightCliPath() {
  const require = createRequire(import.meta.url);
  const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
  if (!fs.existsSync(cli)) throw new Error(`playwright 的安装器不在预期位置：${cli}`);
  return cli;
}

async function installPlaywright(id, def) {
  const dir = dirOf(id);
  fs.mkdirSync(dir, { recursive: true });
  const cli = playwrightCliPath();
  setJob(id, { status: 'installing', progress: 0.05 });
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [cli, 'install', def.browser || 'chromium'], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: dir }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let tail = '';
    const onData = (c) => {
      const s = c.toString(); tail = (tail + s).slice(-2000);
      const m = /(\d{1,3})%/.exec(s);
      if (m) setJob(id, { progress: 0.05 + (Number(m[1]) / 100) * 0.9 });
    };
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`playwright install 退出码 ${code}：${tail.trim().split('\n').pop() || ''}`))));
  });
  const rec = { id, version: def.version || 'playwright', dir, binDirs: [], browsersPath: dir, installedAt: new Date().toISOString() };
  fs.writeFileSync(installedPath(id), JSON.stringify(rec, null, 2));
}

export function uninstallComponent(id) {
  if (!componentsRoot) return false;
  fs.rmSync(dirOf(id), { recursive: true, force: true });
  fs.rmSync(installedPath(id), { force: true });
  jobs.delete(id);
  return true;
}

// ── 工具 ──

function resolveGlobDir(root, pattern) {
  const parts = pattern.split('/').filter(Boolean);
  let cur = root;
  for (const part of parts) {
    if (part.includes('*')) {
      const re = new RegExp('^' + part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      const hit = fs.existsSync(cur) ? fs.readdirSync(cur).find((n) => re.test(n)) : null;
      if (!hit) return null;
      cur = path.join(cur, hit);
    } else {
      cur = path.join(cur, part);
    }
  }
  return fs.existsSync(cur) ? cur : null;
}

/** 流式解压 zip 到 dest；strip = 剥掉前几层目录（上游 zip 常带一层 name-version/） */
export function extractZip(zipPath, dest, strip = 0) {
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
      const p = new Promise((res, rej) => { ws.on('finish', res); ws.on('error', rej); });
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
