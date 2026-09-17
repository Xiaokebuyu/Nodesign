/**
 * server/projects/project-trash.js — 项目回收站的磁盘这一半（09-17，问题库 iss_mtjex6wv_5xhn）
 *
 * 删除不再 `rm -rf <数据根>/<pid>`，而是把整个项目目录挪到 `<数据根>/.trash/<pid>-<时间戳>/`，
 * 保留期满（NODESIGN_TRASH_DAYS，默认 7 天）才真删。库那一半（deleted_at / trash_dir）和编排在
 * trash-lifecycle.js 与 api/project-delete.js。
 *
 * 三条性质：
 *  1. 回收目录在数据根里面。数据根在 Bash 沙盒里整个 denyRead（engine/agent/isolation.js），
 *     工作区范围钩子也按数据根拦，所以回收站对 agent 不可读，跟删除前别人的项目一个待遇。
 *     目录名以点开头，按 `proj_` 前缀或跳过点目录枚举数据根的代码（warm-image-variants 等）天然看不见它。
 *  2. **占位文件**：挪走之后在原路径 `<数据根>/<pid>` 写一个普通文件。迟到的写入（SDK 自己的
 *     `.claude/.cc-writes` mkdir、跑到一半的生图、没有经过存在性闸的 mkdir -p）撞上的是「路径的上一级是文件」，
 *     ENOTDIR 失败，工作区长不回来 —— 这一条不依赖每个写入口都记得先问 project-gone.js。
 *     恢复时先删占位文件再挪回；彻底删除时一起删。
 *  3. Windows 上目录里有文件被占用时 rename 会 EBUSY / EPERM：退避重试，仍失败就把错误交给调用方，
 *     工作区留在原处（到期清理时从原处删）。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PROJECTS_DATA_ROOT } from './workspace.js';
import { validateProjectId } from './store.js';

export const TRASH_DIRNAME = '.trash';
const DEFAULT_DAYS = 7;
const MAX_DAYS = 365;
const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

export function trashRoot() {
  return path.join(PROJECTS_DATA_ROOT, TRASH_DIRNAME);
}

/** 保留期（天）。环境变量非法时回落默认值；0 = 下一次清理就删（不建议，留作运维口子） */
export function trashRetentionDays(env = process.env) {
  const raw = env.NODESIGN_TRASH_DAYS;
  if (raw == null || String(raw).trim() === '') return DEFAULT_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, n);
}

/** 保留到什么时候（ISO）；deletedAt 缺失时 null */
export function purgeAfter(deletedAt, days = trashRetentionDays()) {
  const t = Date.parse(deletedAt || '');
  return Number.isFinite(t) ? new Date(t + days * 86_400_000).toISOString() : null;
}

/** `<pid>-<YYYYMMDDTHHMMSSmmmZ>`：pid 里没有连字符，最后一段就是时间 */
export function trashEntryName(projectId, now = new Date()) {
  validateProjectId(projectId);
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  return `${projectId}-${stamp}`;
}

export function parseTrashEntryName(name) {
  const m = /^(proj_[a-z0-9_]{6,80})-(\d{8}T\d{9}Z)(?:-.*)?$/i.exec(String(name || ''));
  if (!m) return null;
  const s = m[2];
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}.${s.slice(15, 18)}Z`;
  return { projectId: m[1], at: iso };
}

/** 回收目录名 → 绝对路径；名字不合规（含分隔符 / ..）一律拒 */
export function trashPathOf(name) {
  if (!parseTrashEntryName(name) || name.includes('/') || name.includes('\\')) {
    throw Object.assign(new Error(`非法回收目录名: ${JSON.stringify(name)}`), { code: 'INVALID_TRASH_DIR' });
  }
  return path.join(trashRoot(), name);
}

function containerOf(projectId) {
  validateProjectId(projectId);
  return path.join(PROJECTS_DATA_ROOT, projectId);
}

const sleepMs = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/**
 * rename 带退避。Windows 的「文件被占用」表现为 EBUSY / EPERM / EACCES；Linux 上这些码基本不会出现，
 * 重试只是多等几百毫秒。delays 总长约 3 秒。
 */
export async function renameWithRetry(from, to, { delays = [100, 200, 400, 800, 1600], rename = fs.rename, sleep = sleepMs } = {}) {
  let lastErr = null;
  for (let i = 0; i <= delays.length; i += 1) {
    try { await rename(from, to); return; } catch (err) {
      lastErr = err;
      if (!RETRY_CODES.has(err?.code) || i === delays.length) break;
      await sleep(delays[i]);
    }
  }
  throw lastErr;
}

async function lstatOrNull(p) {
  try { return await fs.lstat(p); } catch { return null; }
}

/** 原路径上的占位文件。内容给运维看：为什么这里是个文件 */
export async function writeTombstone(projectId, { trashDir = null, deletedAt = new Date().toISOString() } = {}) {
  const p = containerOf(projectId);
  const body = JSON.stringify({
    nd: 'project-tombstone', projectId, deletedAt, trashDir,
    note: '项目已删除，工作区在回收站里。这个占位文件挡住迟到的写入，别手动删；恢复或彻底删除时由服务端移除。',
  }, null, 2);
  await fs.mkdir(PROJECTS_DATA_ROOT, { recursive: true });
  await fs.writeFile(p, body, { flag: 'wx' });
}

export async function removeTombstone(projectId) {
  const p = containerOf(projectId);
  const st = await lstatOrNull(p);
  if (st && st.isFile()) await fs.rm(p, { force: true });
}

export async function hasTombstone(projectId) {
  const st = await lstatOrNull(containerOf(projectId));
  return !!(st && st.isFile());
}

/**
 * 把项目目录挪进回收站并立占位文件。
 * @returns {Promise<{ trashDir: string|null, tombstone: boolean, moveError: string|null, stray: string|null }>}
 *   trashDir=null 且 moveError=null：删除时本来就没有工作区目录（文件夹项目常见）
 */
export async function moveWorkspaceToTrash(projectId, { now = new Date(), renameOpts } = {}) {
  const src = containerOf(projectId);
  const st = await lstatOrNull(src);
  let trashDir = null;
  let moveError = null;
  if (st && st.isDirectory()) {
    trashDir = trashEntryName(projectId, now);
    await fs.mkdir(trashRoot(), { recursive: true });
    try {
      await renameWithRetry(src, trashPathOf(trashDir), renameOpts);
    } catch (err) {
      moveError = `${err.code || 'ERR'}: ${err.message}`;
      trashDir = null;
    }
  }
  if (moveError) return { trashDir: null, tombstone: false, moveError, stray: null };
  // 原路径上已经是占位文件（上一次删除留下、没被清掉）：不用再立
  if (st && st.isFile()) return { trashDir, tombstone: true, moveError: null, stray: null };
  let tombstone = false;
  let stray = null;
  try {
    await writeTombstone(projectId, { trashDir, deletedAt: now.toISOString() });
    tombstone = true;
  } catch (err) {
    // 挪走和立占位之间被迟到的写入抢先建了目录：把它也挪进回收站（不丢东西），再立一次
    if (err.code === 'EEXIST' || err.code === 'EISDIR') {
      stray = await parkStray(projectId, now);
      try { await writeTombstone(projectId, { trashDir, deletedAt: now.toISOString() }); tombstone = true; } catch { /* 下面报 */ }
    }
    if (!tombstone) console.warn(`[trash] ${projectId} 占位文件没立上：${err.message}`);
  }
  return { trashDir, tombstone, moveError: null, stray };
}

/** 原路径上冒出来的目录（迟到写入重建的）挪进回收站，名字带 -stray，清理时随项目一起删 */
async function parkStray(projectId, now = new Date()) {
  const src = containerOf(projectId);
  const st = await lstatOrNull(src);
  if (!st || !st.isDirectory()) return null;
  const name = `${trashEntryName(projectId, new Date(now.getTime() + 1))}-stray`;
  await fs.mkdir(trashRoot(), { recursive: true });
  await renameWithRetry(src, path.join(trashRoot(), name));
  console.warn(`[trash] ${projectId} 原路径上有迟到写入建出的目录，已挪进回收站 ${name}`);
  return name;
}

/**
 * 从回收站挪回原处。trashDir=null（删除时没有目录 / 没挪成）时只清占位文件。
 * @returns {Promise<{ restored: boolean, stray: string|null }>}
 */
export async function restoreWorkspaceFromTrash(projectId, trashDir, { renameOpts } = {}) {
  await removeTombstone(projectId);
  if (!trashDir) return { restored: false, stray: null };
  const from = trashPathOf(trashDir);
  if (!(await lstatOrNull(from))) {
    throw Object.assign(new Error(`回收站里找不到这个项目的工作区（${trashDir}）`), { code: 'TRASH_MISSING', status: 409 });
  }
  const stray = await parkStray(projectId);
  await renameWithRetry(from, containerOf(projectId), renameOpts);
  return { restored: true, stray };
}

/**
 * 真删：回收目录、同 pid 的 -stray 目录、占位文件；没挪成（moveError）时工作区还在原处，一并删。
 * fs.rm 自带 EBUSY/EPERM 重试（maxRetries），Windows 上占用释放得慢也等得到。
 */
export async function purgeWorkspace(projectId, trashDir, { rm = fs.rm } = {}) {
  const opts = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };
  const targets = [];
  if (trashDir) targets.push(trashPathOf(trashDir));
  for (const name of await listTrashEntries()) {
    const parsed = parseTrashEntryName(name);
    if (parsed?.projectId === projectId && name !== trashDir && name.endsWith('-stray')) targets.push(path.join(trashRoot(), name));
  }
  const container = containerOf(projectId);
  const st = await lstatOrNull(container);
  if (st?.isDirectory()) targets.push(container);
  for (const t of targets) await rm(t, opts);
  await removeTombstone(projectId);
  return { removed: targets.length };
}

export async function listTrashEntries() {
  try {
    return (await fs.readdir(trashRoot(), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * 目录大小（审计用）。上限 maxEntries 个条目，超了就停、标 truncated —— 最大的项目两百多兆、上万个文件，
 * 删除请求不该为了一个审计数字扫太久。不跟软链。
 */
export async function measureDir(dir, { maxEntries = 50_000 } = {}) {
  let bytes = 0; let files = 0; let seen = 0; let truncated = false;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = await fs.readdir(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      seen += 1;
      if (seen > maxEntries) { truncated = true; break; }
      const p = path.join(cur, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.isFile()) continue;
      try { bytes += (await fs.lstat(p)).size; files += 1; } catch { /* 扫的途中没了 */ }
    }
    if (truncated) break;
  }
  return { bytes, files, truncated };
}
