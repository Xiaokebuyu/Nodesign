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
import { createRequire } from 'node:module';
import { profile } from './profile.js';
// 选源 / 下载 / 解压那一半（09-10 拆出去，行数棘轮）。这里连同原来的导出一起转出，调用方不用改
import { sourcesFor, probeSource, pickSource, downloadFile, extractZip, envMirrors, DEFAULT_MIRRORS } from './components-fetch.js';
export { sourcesFor, probeSource, pickSource, downloadFile, extractZip, DEFAULT_MIRRORS };
// 装/卸 rembg 之前要停它的常驻 python（见 COMPONENT_HOLDERS）
import { startRembgService, stopRembgService } from '../services/rembg-launcher.js';
import { loadPrefs, savePrefs } from './local-prefs.js';

export const COMPONENTS_MANIFEST_URL = process.env.NODESIGN_COMPONENTS_MANIFEST
  || 'https://github.com/Xiaokebuyu/Nodesign/releases/download/components-win64/manifest.json';
const MANIFEST_TTL_MS = 60 * 60 * 1000;

/** 默认位置：<dataRoot>/components */
export const defaultComponentsRoot = profile.isLocal ? path.join(profile.dataRoot, 'components') : null;
/**
 * 现在的位置（09-08 站主：不能只装 C 盘）：prefs.componentsDir 优先，否则默认。是函数不是常量 —— 换位置后立刻生效。
 * ⚠️ 已装记录（<id>.json）里的 bin 目录是绝对路径，换位置要连记录一起搬（relocateComponents）。
 */
export function getComponentsRoot() {
  if (!profile.isLocal) return null;
  const pref = loadPrefs().componentsDir;
  return pref && path.isAbsolute(pref) ? pref : defaultComponentsRoot;
}
const platformKey = `${process.platform}-${process.arch}`;

let manifestCache = { at: 0, manifest: null, error: null };
/** id → { status: 'idle'|'probing'|'downloading'|'verifying'|'extracting'|'installing'|'done'|'error', progress, bytes, total, error, source, sourceUrl } */
const jobs = new Map();

// ── 清单 ──

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

/** 判据专用：把内存里的缓存与任务清空（磁盘上的记录不动） */
export function _resetComponents() { manifestCache = { at: 0, manifest: null, error: null }; jobs.clear(); }

// ── 已装状态（磁盘） ──

function installedPath(id) { return path.join(getComponentsRoot(), `${id}.json`); }
function dirOf(id) { return path.join(getComponentsRoot(), id); }
/**
 * 装到哪个目录（09-10 改）：`<root>/<id>-<sha 前 8 位>`，**每个版本一个新目录**。
 *
 * 起因是站主更新 rembg 时的 `EPERM, Permission denied … \components\rembg`：原来的做法是
 * "先把 `<root>/<id>` 整个删掉再解压"，而 Windows 上那个目录随时可能删不动 —— 杀软在扫、
 * 资源管理器开着、或者我们自己 spawn 的 python 还攥着 DLL。**装一个新东西不该以能删掉旧东西为前提。**
 * 记录里存的全是绝对路径（dir / binDirs / python / modelsDir），所以换个目录名没有任何人需要知道。
 * 旧目录装完之后尽力清（sweepOtherDirs），清不掉也只是占地方，不影响用。
 */
function installDirFor(id, def) {
  const tag = typeof def?.sha256 === 'string' && /^[0-9a-f]{8}/.test(def.sha256) ? def.sha256.slice(0, 8) : null;
  return tag ? path.join(getComponentsRoot(), `${id}-${tag}`) : dirOf(id);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 删目录，Windows 上要有耐心：杀软扫描 / 刚退出的进程还没放开句柄，都会让 rm 当场 EPERM，
 * 而这些锁通常一两秒就没了。node 自己的 maxRetries 在 rm 内部退避，外面再包一层给它更长的机会。
 * 最后还是不行就把真话抛出去，调用方决定这是致命还是"先留着"。
 */
async function rmDir(dir, { attempts = 4 } = {}) {
  for (let i = 1; ; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); return; }
    catch (err) {
      if (i >= attempts) throw err;
      await sleep(300 * i);
    }
  }
}

/** 同一个组件留下的别的目录（旧版本、上次没删干净的）尽力清掉；清不掉**不算装失败** */
async function sweepOtherDirs(id, keepDir) {
  const root = getComponentsRoot();
  if (!root) return;
  const keep = path.resolve(keepDir || '');
  const mine = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-[0-9a-f]{8})?$`);
  let names = [];
  try { names = fs.readdirSync(root); } catch { return; }
  for (const name of names) {
    if (!mine.test(name)) continue;
    const full = path.join(root, name);
    if (path.resolve(full) === keep) continue;
    try { if (!fs.statSync(full).isDirectory()) continue; } catch { continue; }
    try { await rmDir(full, { attempts: 2 }); console.log(`[components] 清掉旧目录 ${full}`); }
    catch (err) { console.warn(`[components] 旧目录暂时删不掉（不影响使用，下次起动再试）：${full} ${err.code || err.message}`); }
  }
}

/**
 * 谁攥着这个组件的文件 —— 装之前先停，装完再拉起来（09-10）。
 * rembg 的 python.exe 是服务端自己 spawn 的常驻进程：不停它，Windows 上连删都删不动，
 * 而且装完不重开的话，跑着的还是**旧包里的**那个解释器。
 * ⚠️ 这张表是「装/卸组件」与「谁在用它」之间唯一的接头处，加组件时想一下要不要在这儿留一条。
 */
export const COMPONENT_HOLDERS = {
  rembg: {
    stop: () => stopRembgService(),
    start: () => { startRembgService().catch((err) => console.warn(`[components] rembg 服务没拉起来：${err.message}`)); },
  },
};

/**
 * 起动时扫一遍：每个装着的组件，把**记录没指着的**同名目录清掉（09-10）。
 * 上一次更新时删不掉的旧目录（那会儿文件还被占着）在这里有第二次机会 —— 而这时候
 * rembg 的常驻 python 还没起来（index.js 里这一步在 startRembgService 之前），最容易删得动。
 * 删不掉就再等下一次，不影响任何功能。
 */
export async function sweepStaleComponentDirs() {
  if (!getComponentsRoot()) return;
  for (const id of listInstalledIds()) {
    const rec = readInstalled(id);
    if (rec?.dir) await sweepOtherDirs(id, rec.dir);
  }
}

export function readInstalled(id) {
  try { return JSON.parse(fs.readFileSync(installedPath(id), 'utf8')); } catch { return null; }
}

function listInstalledIds() {
  try { return fs.readdirSync(getComponentsRoot()).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch { return []; }
}

/**
 * 装了的组件要给进程的东西：PATH 前缀目录 + 几个专用 env。起动时和每次装完都调一次。
 * @returns {{ binDirs: string[], env: Record<string,string> }}
 */
export function componentEnv() {
  const binDirs = []; const env = {};
  if (!getComponentsRoot()) return { binDirs, env };
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
  if (!getComponentsRoot()) return { platform: platformKey, manifestError: null, components: [] };
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
      // 装着的那份跟清单对不上 = 有更新（09-10）。判据用 **sha256 不是版本号**：rembg 那次修的是包里
      // 缺 msvcp140（见 components.yml），版本号一个字都不用变，只认版本号的话所有装过的用户永远拿不到修好的包。
      // 装是覆盖式的（installZip 先 rm 整个目录），所以"更新"就是再装一次，不用先卸。
      outdated: !!(installed && def.sha256 && installed.sha256 && String(installed.sha256).toLowerCase() !== String(def.sha256).toLowerCase()),
      job,
    };
  });
  return { platform: platformKey, manifestError: manifestCache.error, components: out, location: componentsLocation(), relocation };
}

// ── 位置（09-08 站主：外部程序不能只装 C 盘）──

let relocation = null;   // { status:'moving'|'done'|'error', from, to, done, total, error? }

export function componentsLocation() {
  return { dir: getComponentsRoot(), defaultDir: defaultComponentsRoot, custom: getComponentsRoot() !== defaultComponentsRoot };
}

/**
 * 换组件目录。已装的搬过去（复制 + 改记录里的绝对路径 + 删旧的），搬完新目录生效、PATH 补上新目录、能力表重探。
 * 后台跑，状态在 listComponents().relocation 里给前端轮询。正在装组件时拒绝（.download 和目录都在动）。
 */
export async function relocateComponents(dir, { move = true } = {}) {
  if (!profile.isLocal) throw Object.assign(new Error('hosted profile 没有组件'), { code: 'NOT_LOCAL' });
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw Object.assign(new Error('要一个绝对路径'), { code: 'BAD_DIR' });
  const to = path.resolve(dir);
  const from = getComponentsRoot();
  if (to === from) return { ok: true, unchanged: true, location: componentsLocation() };
  if ([...jobs.values()].some((j) => j.status === 'downloading' || j.status === 'extracting' || j.status === 'installing')) {
    throw Object.assign(new Error('正在装组件，装完再换位置'), { code: 'BUSY' });
  }
  if (relocation?.status === 'moving') throw Object.assign(new Error('正在搬，等它完'), { code: 'BUSY' });
  // 目标必须能写；不能是数据目录本身 / 组件目录的子目录
  if (to === path.resolve(profile.dataRoot) || (from && to.startsWith(from + path.sep))) throw Object.assign(new Error('不能选这个位置'), { code: 'BAD_DIR' });
  fs.mkdirSync(to, { recursive: true });
  const probeFile = path.join(to, `.nd-write-test-${process.pid}`);
  try { fs.writeFileSync(probeFile, 'ok'); fs.rmSync(probeFile, { force: true }); } catch (err) { throw Object.assign(new Error(`这个位置写不了：${err.message}`), { code: 'NOT_WRITABLE' }); }
  const ids = move ? listInstalledIds() : [];
  relocation = { status: 'moving', from, to, done: 0, total: ids.length, error: null };
  (async () => {
    try {
      for (const id of ids) {
        const rec = readInstalled(id);
        // 目录名不再一定等于 id（09-10 起是 <id>-<sha8>），按记录走；记录里没有就退回老布局
        const srcDir = rec?.dir && fs.existsSync(rec.dir) ? rec.dir : path.join(from, id);
        const dstDir = path.join(to, path.basename(srcDir));
        if (fs.existsSync(srcDir)) {
          fs.rmSync(dstDir, { recursive: true, force: true });
          fs.cpSync(srcDir, dstDir, { recursive: true });
        }
        if (rec) {
          const swap = (v) => (typeof v === 'string' && v.startsWith(from) ? to + v.slice(from.length) : v);
          const next = JSON.parse(JSON.stringify(rec), (_k, v) => (Array.isArray(v) ? v.map(swap) : swap(v)));
          fs.writeFileSync(path.join(to, `${id}.json`), JSON.stringify(next, null, 2) + '\n');
        }
        // 新目录写好了再删旧的：中途断电最多是两份，不会一份都没有
        fs.rmSync(srcDir, { recursive: true, force: true });
        fs.rmSync(path.join(from, `${id}.json`), { force: true });
        relocation.done++;
      }
      savePrefs({ componentsDir: to === defaultComponentsRoot ? null : to });
      applyComponentEnv();
      relocation.status = 'done';
    } catch (err) {
      relocation.status = 'error';
      relocation.error = err.message;
    }
  })();
  return { ok: true, relocation, location: componentsLocation() };
}

// ── 安装 ──

function setJob(id, patch) { jobs.set(id, { ...(jobs.get(id) || { status: 'idle', progress: 0 }), ...patch }); }

/** 装一个组件（幂等：正在装就返回现有任务；装完了且版本一样直接返回） */
export async function installComponent(id) {
  if (!getComponentsRoot()) throw new Error('hosted profile 没有组件');
  const manifest = await loadManifest();
  const def = manifest?.components?.[id];
  if (!def) throw Object.assign(new Error(`清单里没有组件 ${id}`), { code: 'UNKNOWN_COMPONENT' });
  if (def.platform && def.platform !== platformKey) throw Object.assign(new Error(`组件 ${id} 只有 ${def.platform} 的包，这台是 ${platformKey}`), { code: 'UNSUPPORTED_PLATFORM' });
  const cur = jobs.get(id);
  if (cur && ['probing', 'downloading', 'verifying', 'extracting', 'installing'].includes(cur.status)) return cur;
  fs.mkdirSync(getComponentsRoot(), { recursive: true });
  setJob(id, { status: 'downloading', progress: 0, bytes: 0, total: null, error: null });
  // 不 await：调用方拿任务状态轮询
  (async () => {
    const holder = COMPONENT_HOLDERS[id] || null;
    // 停在最前面：跑着的进程攥着旧包的文件，Windows 上连删都删不动（09-10 站主更新 rembg 撞的 EPERM）
    try { holder?.stop(); } catch (err) { console.warn(`[components] 停 ${id} 的常驻进程失败（继续装）：${err.message}`); }
    try {
      if (def.kind === 'playwright') await installPlaywright(id, def);
      else await installZip(id, def);
      applyComponentEnv();
      setJob(id, { status: 'done', progress: 1 });
    } catch (err) {
      console.error(`[components] 装 ${id} 失败：${err.message}`);
      setJob(id, { status: 'error', error: err.message });
      try {
        for (const f of fs.readdirSync(getComponentsRoot())) if (f.startsWith(`${id}.`) && f.endsWith('.download')) fs.rmSync(path.join(getComponentsRoot(), f), { force: true });
      } catch { /* */ }
      // 收拾这次尝试留下的半截。⚠️ 只删**这次装进去的那个目录**，不碰已经能用的那份 ——
      // 09-10 之前这里一把 rmSync(dirOf(id))，等于"更新失败顺手把能用的旧版本也毁了"。
      // chromium 是例外：它自己一上来就把 <id> 整个清了（部件按 playwright 的目录规则落盘），
      // 失败时那份已经是半截，留着比删掉更坏 —— 连记录一起撤，界面老实说"未安装"。
      const live = readInstalled(id)?.dir || null;
      const attempt = def.kind === 'playwright' ? dirOf(id) : installDirFor(id, def);
      if (def.kind === 'playwright' || !live || path.resolve(attempt) !== path.resolve(live)) {
        try { await rmDir(attempt, { attempts: 2 }); } catch { /* 删不掉就留着，下次装/起动再扫 */ }
        if (live && path.resolve(attempt) === path.resolve(live)) fs.rmSync(installedPath(id), { force: true });
      }
    }
    // 成功要用新包重开，失败也要把旧的拉回来 —— 别让一次更新把用户的抠图变成不可用
    try { holder?.start(); } catch (err) { console.warn(`[components] 拉起 ${id} 的常驻进程失败：${err.message}`); }
  })();
  return jobs.get(id);
}

async function installZip(id, def) {
  const dir = installDirFor(id, def);      // 每个版本一个目录，装新的不用先删旧的（见 installDirFor）
  await rmDir(dir);                        // 同一版本重装：这个目录是上一次的自己，删得动
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(getComponentsRoot(), `${id}.download`);

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
  // 记录先落定再扫尾：中途断电最多是多占一份地方，不会出现"记录指着已经被删的目录"
  await sweepOtherDirs(id, dir);
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
    const tmp = path.join(getComponentsRoot(), `${id}.${part.name}.download`);
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

export async function uninstallComponent(id) {
  if (!getComponentsRoot()) return false;
  const holder = COMPONENT_HOLDERS[id] || null;
  try { holder?.stop(); } catch { /* 停不掉也照删，下面 rmDir 会有耐心 */ }
  const rec = readInstalled(id);
  // 记录里那份（可能是 <id>-<sha8>）先删，再扫掉同名的其它目录（老布局的 <id> 也在内）
  if (rec?.dir) { try { await rmDir(rec.dir); } catch (err) { console.warn(`[components] 卸 ${id}：${rec.dir} 删不掉 ${err.code || err.message}`); } }
  await sweepOtherDirs(id, null);
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
