/**
 * server/runtime/components.js — 本地分发版的组件管理器（09-06，站主定的"首启引导页下载"那条路）。
 *
 * 组件 = 安装包里不带、按需下载到 <dataRoot>/components/<id>/ 的外部程序：git、ffmpeg、poppler、LibreOffice、
 * rembg 环境、chromium。清单（叫什么、多大、从哪下、sha256、装完哪个目录进 PATH）不写死在代码里，从站点
 * 仓库一个固定 release 的 manifest.json 读（COMPONENTS_MANIFEST_URL），换组件版本不用发应用。
 *
 * 装一个组件 = 下载（流式，边下边算 sha256，进度按 content-length）→ 校验 → 解压（fflate 流式，400MB 的
 * LibreOffice 也不进内存）→ 按清单把 bin 目录算成绝对路径写进 <id>.json → 把目录挂进 PATH → 重探能力表。
 * chromium 也走同一条管道（09-07 起）：部件表（chromium / headless shell / ffmpeg / winldd）问 playwright 自己的
 * registry 要，按它的目录规则落进 <components>/chromium/，装完写 INSTALLATION_COMPLETE 标记，运行时只需
 * PLAYWRIGHT_BROWSERS_PATH 指过去。⛔ 不再调 `playwright install`：它的官方源现在跳 storage.googleapis.com
 * （国内不通），而 PLAYWRIGHT_DOWNLOAD_HOST 只能换主机不能换路径，npmmirror 上 chrome-for-testing 的路径跟它
 * 要的 builds/cft/… 对不上，两头都死 —— 站主 09-06 在 Windows 引导页上撞的"退出码 1"就是这个。
 *
 * 状态全在内存里一张表（前端轮询 GET /api/local/components），进程重启后按磁盘上的 <id>.json 认"装了没"。
 * 只在 local profile 有意义；hosted 下 listComponents 返回空。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';
import { profile } from './profile.js';

export const COMPONENTS_MANIFEST_URL = process.env.NODESIGN_COMPONENTS_MANIFEST
  || 'https://github.com/Xiaokebuyu/Nodesign/releases/download/components-win64/manifest.json';
/**
 * 镜像（站主 09-06：GitHub 在国内经常"通但只有几十 KB/s"）。每个镜像是一个目录前缀，里面按文件名放同一批资产
 * （manifest.json 和各个 zip），server/scripts/sync-components-mirror.sh 从 release 同步过去。
 * 清单自己的 mirrors 字段优先，其次 env NODESIGN_COMPONENTS_MIRRORS（逗号分隔），最后这份内置默认。
 */
export const DEFAULT_MIRRORS = ['https://nodesign.xiaobuyu.trade/dl/components-win64'];
const MANIFEST_TTL_MS = 60 * 60 * 1000;
const PROBE_BYTES = 512 * 1024;
const PROBE_TIMEOUT_MS = 8000;
/** 官方能通且吞吐不低于最快镜像的这个比例就用官方（官方永远是最新版，镜像可能落后） */
const OFFICIAL_KEEP_RATIO = 1 / 3;

export const componentsRoot = profile.isLocal ? path.join(profile.dataRoot, 'components') : null;
const platformKey = `${process.platform}-${process.arch}`;

let manifestCache = { at: 0, manifest: null, error: null };
/** id → { status: 'idle'|'probing'|'downloading'|'verifying'|'extracting'|'installing'|'done'|'error', progress, bytes, total, error, source, sourceUrl } */
const jobs = new Map();

// ── 清单 ──

function envMirrors() {
  return (process.env.NODESIGN_COMPONENTS_MIRRORS || '').split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean);
}

/** 清单：官方地址不通就挨个试镜像里的 manifest.json（镜像可能落后一版，所以官方先） */
export async function loadManifest({ force = false } = {}) {
  if (!force && manifestCache.manifest && Date.now() - manifestCache.at < MANIFEST_TTL_MS) return manifestCache.manifest;
  const candidates = /^https?:/.test(COMPONENTS_MANIFEST_URL)
    ? [COMPONENTS_MANIFEST_URL, ...[...envMirrors(), ...(process.env.NODESIGN_COMPONENTS_MANIFEST ? [] : DEFAULT_MIRRORS)].map((m) => `${m}/manifest.json`)]
    : [COMPONENTS_MANIFEST_URL];
  const errors = [];
  for (const url of candidates) {
    try {
      let manifest;
      if (/^https?:/.test(url)) {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        manifest = await res.json();
      } else {
        manifest = JSON.parse(fs.readFileSync(url, 'utf8'));
      }
      if (!manifest?.components || typeof manifest.components !== 'object') throw new Error('manifest 没有 components');
      manifestCache = { at: Date.now(), manifest, error: null, from: url };
      return manifest;
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    }
  }
  manifestCache = { ...manifestCache, error: errors.join('；') };
  if (!manifestCache.manifest) console.warn(`[components] 清单拉不到：${errors.join('；')}`);
  return manifestCache.manifest;
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
      id, label: def.label || id, uses: def.uses || '', required: !!def.required, kind: def.kind || 'zip',
      sizeMb: def.kind === 'playwright' ? PLAYWRIGHT_BUNDLE_MB : (def.sizeMb || null),
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
  if (cur && ['probing', 'downloading', 'verifying', 'extracting', 'installing'].includes(cur.status)) return cur;
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
      try {
        fs.rmSync(dirOf(id), { recursive: true, force: true });
        for (const f of fs.readdirSync(componentsRoot)) if (f.startsWith(`${id}.`) && f.endsWith('.download')) fs.rmSync(path.join(componentsRoot, f), { force: true });
      } catch { /* */ }
    }
  })();
  return jobs.get(id);
}

async function installZip(id, def) {
  const dir = dirOf(id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(componentsRoot, `${id}.download`);

  // 选源（官方 vs 镜像测速），然后下载 + sha256
  setJob(id, { status: 'probing' });
  const { chosen, results } = await pickSource(sourcesFor(def, manifestCache.manifest));
  console.log(`[components] ${id} 选源 ${chosen.kind} ${chosen.url}（${results.map((r) => `${r.kind}:${r.probe.ok ? Math.round(r.probe.bytesPerSec / 1024) + 'KB/s' : '✗ ' + r.probe.error}`).join(' ')}）`);
  setJob(id, { status: 'downloading', source: chosen.kind, sourceUrl: chosen.url });
  const { sha256: digest } = await downloadFile(chosen.url, tmp, {
    onProgress: (bytes, total) => setJob(id, { bytes, total, progress: total ? Math.min(0.85, (bytes / total) * 0.85) : 0.3 }),
  });
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

// ── chromium：按 playwright 的目录规则落盘，下载走上面同一条管道 ──

/** npmmirror 的二进制镜像根；playwright 的 builds/ 整目录和 chrome-for-testing 都在这底下 */
export const PLAYWRIGHT_MIRROR = process.env.NODESIGN_PLAYWRIGHT_MIRROR || 'https://registry.npmmirror.com/-/binary';

/**
 * 官方地址 → npmmirror 上对应的地址。两种形状：
 *   …/builds/cft/<chrome 版本>/<平台>/<文件>  →  <镜像根>/chrome-for-testing/<版本>/<平台>/<文件>
 *   …/builds/<其余>                         →  <镜像根>/playwright/builds/<其余>
 * （npmmirror 的 playwright/builds/cft/ 目录不全，chrome-for-testing/ 才是按 Google 原样同步的那份。）
 */
export function playwrightMirrorUrl(officialUrl, base = PLAYWRIGHT_MIRROR) {
  let pathname;
  try { pathname = new URL(officialUrl).pathname; } catch { return null; }
  let m = /\/builds\/cft\/([^/]+)\/(.+)$/.exec(pathname);
  if (m) return `${base}/chrome-for-testing/${m[1]}/${m[2]}`;
  m = /\/builds\/(.+)$/.exec(pathname);
  if (m) return `${base}/playwright/builds/${m[1]}`;
  return null;
}

/** `playwright install chromium` 会装的那几样：浏览器本体、headless shell、录像用的 ffmpeg，Windows 上多一个查 DLL 的 winldd */
export function playwrightPartNames(platform = process.platform) {
  return ['chromium', 'chromium-headless-shell', 'ffmpeg', ...(platform === 'win32' ? ['winldd'] : [])];
}

/**
 * 部件表：{ name, revision, dir, exe, sources }[]。dir 用 playwright 自己算的目录名（chromium-1217 /
 * chromium_headless_shell-1217 …）换个根；exe 是相对 dir 的可执行路径，装完用它验"真解出来了"。
 * registry 是 playwright-core 公开导出的那份（lib/server 的 registry），downloadURLs 已按当前平台算好。
 */
export function playwrightParts(browsersPath, { platform = process.platform, registry = null } = {}) {
  const require = createRequire(import.meta.url);
  const reg = registry || require('playwright-core/lib/server').registry;
  return playwrightPartNames(platform).map((name) => {
    const e = reg.findExecutable(name);
    if (!e || !e.directory) throw new Error(`playwright 的 registry 里没有 ${name}`);
    const urls = e.downloadURLs || [];
    if (!urls.length) throw new Error(`playwright 没有 ${name} 在 ${platform}-${process.arch} 的下载地址`);
    const exeAbs = e.executablePath?.();
    const exe = exeAbs ? path.relative(e.directory, exeAbs) : null;
    // 官方那几条（cdn.playwright.dev 的几个别名）在前，镜像按第一条官方地址推
    const mirror = playwrightMirrorUrl(urls[0]);
    const sources = [...urls.map((url) => ({ kind: 'official', url })), ...(mirror ? [{ kind: 'mirror', url: mirror }] : [])];
    return { name, revision: e.revision, dir: path.join(browsersPath, path.basename(e.directory)), exe, sources };
  });
}

/** 进度权重：headless shell 跟本体差不多大，其余两个加起来不到 2MB */
const PW_PART_WEIGHT = { chromium: 0.6, 'chromium-headless-shell': 0.37 };
/** 四个部件 win64 合计（147.0.7727.15：188 + 117 + 1.4 + 0.1）。体积随应用里的 playwright 走，清单说了不算，列表里用这个 */
export const PLAYWRIGHT_BUNDLE_MB = 310;

async function installPlaywright(id, def) {
  const dir = dirOf(id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // 清单可以显式给 parts（{name, dir 相对 browsersPath, exe, sources}），不给就问 playwright 的 registry
  const parts = Array.isArray(def.parts)
    ? def.parts.map((p) => ({ ...p, dir: path.join(dir, p.dir) }))
    : playwrightParts(dir);
  const weights = parts.map((p) => PW_PART_WEIGHT[p.name] ?? 0.015);
  const wsum = weights.reduce((a, b) => a + b, 0);
  let done = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const w = weights[i] / wsum;
    const base = done;
    setJob(id, { status: 'probing', part: part.name, progress: base });
    const tmp = path.join(componentsRoot, `${id}.${part.name}.download`);
    const { chosen, results } = await pickSource(part.sources);
    console.log(`[components] ${id}/${part.name} 选源 ${chosen.kind} ${chosen.url}（${results.map((r) => `${r.kind}:${r.probe.ok ? Math.round(r.probe.bytesPerSec / 1024) + 'KB/s' : '✗ ' + r.probe.error}`).join(' ')}）`);
    setJob(id, { status: 'downloading', source: chosen.kind, sourceUrl: chosen.url });
    await downloadFile(chosen.url, tmp, {
      onProgress: (bytes, total) => setJob(id, { bytes, total, progress: base + (total ? (bytes / total) * 0.9 : 0.3) * w }),
    });
    setJob(id, { status: 'extracting', progress: base + 0.92 * w });
    fs.mkdirSync(part.dir, { recursive: true });
    await extractZip(tmp, part.dir, 0);
    fs.rmSync(tmp, { force: true });
    if (part.exe && !fs.existsSync(path.join(part.dir, part.exe))) throw new Error(`${part.name} 解压完没有 ${part.exe}（包的目录结构跟 playwright 期望的不一样）`);
    // playwright 认这个标记文件才算"装了"（registry 的 browserDirectoryToMarkerFilePath）
    fs.writeFileSync(path.join(part.dir, 'INSTALLATION_COMPLETE'), '');
    done = base + w;
  }
  setJob(id, { status: 'installing', progress: 0.99, part: null });
  const rec = {
    id, version: def.version || 'playwright', dir, binDirs: [], browsersPath: dir,
    parts: Object.fromEntries(parts.map((p) => [p.name, { revision: p.revision ?? null, dir: p.dir, exe: p.exe ? path.join(p.dir, p.exe) : null }])),
    installedAt: new Date().toISOString(),
  };
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

/**
 * 读 zip 中央目录里的 unix 权限位：文件名 → mode。fflate 的流式解析只看局部文件头，权限位只在中央目录
 * （外部属性高 16 位，且只有 version-made-by 的高字节 = 3（unix）那套才算数），所以自己从文件尾部读一遍。
 * 认 zip64（LibreOffice 那种上万条目的包）。解析不了返回空表 —— 权限位只是锦上添花，别让它拦下安装。
 */
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
