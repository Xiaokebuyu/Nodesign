/**
 * server/projects/repo.js — 仓库卡的后端（2026-09-08 存量仓库道·第二段）
 *
 * 用户的文件夹在画布上是一张**仓库卡**：桌面缩进 `.nodesign/` 之后，他的东西不在桌面上，
 * 这张卡是看向文件夹的一扇窗。三件事：
 *   - summary：分支 / 上次提交 / 改动计数（没有 git 就只有名字和首开快照）
 *   - tree：列一层目录，每条带 git 状态（子目录聚合成「里面有几处改动」）
 *   - file：读一份文本文件给代码阅读器（512KB 封顶，二进制不读）
 *
 * ⛔ 只读。仓库卡不搬文件、不改文件 —— 改动是 agent 在 cwd 里做的，这里只是看。
 * ⛔ 路径全部锁在文件夹里：`..` 拒、软链跳出去也拒（realpath 对比）。
 * git 状态一次 `status --porcelain=v1 -z` 全拿，按请求缓存 2 秒 —— 树展开一层一次请求，
 * 不能每层都跑一次 git。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { folderPathOf } from './store.js';
import { NODESIGN_DIR, BASELINE_FILE, deskRelOf, DESK_NESTED } from './workspace-layout.js';
import { HARD_IGNORE_DIRS } from '../lib/task-scan.js';

export const MAX_FILE_BYTES = 512 * 1024;
const STATUS_TTL_MS = 2000;
const statusCache = new Map();   // folder → { at, data }

function repoError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

/** 这个项目有没有仓库卡：文件夹项目且桌面缩进 .nodesign（桌面 = 文件夹本身的没有「外面」可看） */
export function repoFolderOf(projectId) {
  const folder = folderPathOf(projectId);
  if (!folder) return null;
  return deskRelOf(folder) === DESK_NESTED ? folder : null;
}

function git(cwd, args, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch { resolve(null); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', code => { clearTimeout(timer); resolve(code === 0 ? out : null); });
  });
}

async function isGitRepo(folder) {
  try { return (await fs.stat(path.join(folder, '.git'))).isDirectory(); } catch { return false; }
}

/**
 * git 状态表：rel → 'M' | 'A' | 'D' | '?' | 'R'（工作树 + 暂存区合并成一个字母，够仓库卡用）。
 * 返回 null = 不是 git 仓库或 git 不在。
 */
export async function gitStatusMap(folder) {
  const hit = statusCache.get(folder);
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.data;
  let data = null;
  if (await isGitRepo(folder)) {
    const raw = await git(folder, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (raw != null) {
      data = new Map();
      const parts = raw.split('\0');
      for (let i = 0; i < parts.length; i++) {
        const rec = parts[i];
        if (rec.length < 4) continue;
        const x = rec[0]; const y = rec[1];
        const rel = rec.slice(3);
        let code;
        if (x === '?' || y === '?') code = '?';
        else if (x === 'D' || y === 'D') code = 'D';
        else if (x === 'A') code = 'A';
        else if (x === 'R' || y === 'R') { code = 'R'; i++; }   // -z 下改名多带一段原路径
        else code = 'M';
        data.set(rel.replace(/\\/g, '/'), code);
      }
    }
  }
  statusCache.set(folder, { at: Date.now(), data });
  return data;
}

/** 分支 + HEAD 一行 + 改动计数 */
export async function repoSummary(projectId) {
  const folder = repoFolderOf(projectId);
  if (!folder) return null;
  let baseline = null;
  try { baseline = JSON.parse(await fs.readFile(path.join(folder, NODESIGN_DIR, BASELINE_FILE), 'utf8')); } catch { /* 没拍过 */ }
  const out = { folder, name: path.basename(folder), baselineAt: baseline?.at || null, git: null };
  if (await isGitRepo(folder)) {
    const [branch, head, status] = await Promise.all([
      git(folder, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(folder, ['log', '-1', '--format=%h%x00%s%x00%cI']),
      gitStatusMap(folder),
    ]);
    const [sha = '', subject = '', when = ''] = (head || '').trim().split('\0');
    const counts = { modified: 0, added: 0, deleted: 0, untracked: 0 };
    for (const code of status?.values() || []) {
      if (code === '?') counts.untracked++;
      else if (code === 'D') counts.deleted++;
      else if (code === 'A') counts.added++;
      else counts.modified++;
    }
    out.git = { branch: (branch || '').trim() || null, head: sha ? { sha, subject, when } : null, counts };
  }
  return out;
}

/** 把相对路径锁在文件夹里；'' = 根。软链跳出去也拒。 */
export async function resolveInside(folder, rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.split('/').some(seg => seg === '..')) throw repoError('REPO_PATH_OUTSIDE', '路径跳出了文件夹');
  const abs = path.resolve(folder, clean);
  if (abs !== folder && !abs.startsWith(folder + path.sep)) throw repoError('REPO_PATH_OUTSIDE', '路径跳出了文件夹');
  let real;
  try { real = await fs.realpath(abs); } catch { throw repoError('REPO_NOT_FOUND', '没有这个路径', 404); }
  const realFolder = await fs.realpath(folder);
  if (real !== realFolder && !real.startsWith(realFolder + path.sep)) throw repoError('REPO_PATH_OUTSIDE', '软链指到了文件夹外面');
  return { abs, rel: clean };
}

/**
 * 列一层。根上不列 `.nodesign`（那是桌面自己）。`.git` 不列。HARD_IGNORE_DIRS 里的目录列出来
 * 但标 `ignored: true`（前端灰掉、不展开）—— 用户得知道 node_modules 在那儿，只是不该逛进去。
 * 状态：文件取自己那条；目录聚合成 `changes`（底下有几条改动）。
 */
export async function repoTree(projectId, rel = '') {
  const folder = repoFolderOf(projectId);
  if (!folder) throw repoError('NOT_REPO_PROJECT', '这个项目没有仓库卡', 404);
  const { abs, rel: clean } = await resolveInside(folder, rel);
  let entries;
  try { entries = await fs.readdir(abs, { withFileTypes: true }); } catch { throw repoError('REPO_NOT_FOUND', '没有这个目录', 404); }
  const status = await gitStatusMap(folder);
  const prefix = clean ? clean + '/' : '';
  const out = [];
  for (const e of entries) {
    if (e.name === '.git') continue;
    if (!clean && e.name === NODESIGN_DIR) continue;
    const item = { name: e.name, dir: e.isDirectory(), rel: prefix + e.name };
    if (item.dir) {
      if (HARD_IGNORE_DIRS.has(e.name)) item.ignored = true;
      if (status) {
        let n = 0;
        const p = item.rel + '/';
        for (const k of status.keys()) if (k.startsWith(p)) n++;
        if (n) item.changes = n;
      }
    } else {
      try { item.size = (await fs.stat(path.join(abs, e.name))).size; } catch { /* 读不到就不给 */ }
      if (status?.has(item.rel)) item.status = status.get(item.rel);
    }
    out.push(item);
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { path: clean, entries: out, git: !!status };
}

/** 读一份文本文件。二进制（前 8KB 里有 NUL）不读；超 512KB 截断并标 truncated。 */
export async function repoFile(projectId, rel) {
  const folder = repoFolderOf(projectId);
  if (!folder) throw repoError('NOT_REPO_PROJECT', '这个项目没有仓库卡', 404);
  const { abs, rel: clean } = await resolveInside(folder, rel);
  let st;
  try { st = await fs.stat(abs); } catch { throw repoError('REPO_NOT_FOUND', '没有这个文件', 404); }
  if (!st.isFile()) throw repoError('REPO_NOT_FILE', '不是文件');
  const fh = await fs.open(abs, 'r');
  try {
    const len = Math.min(st.size, MAX_FILE_BYTES);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    const head = buf.subarray(0, Math.min(len, 8192));
    if (head.includes(0)) return { path: clean, size: st.size, binary: true, text: null, truncated: false };
    return { path: clean, size: st.size, binary: false, text: buf.toString('utf8'), truncated: st.size > MAX_FILE_BYTES };
  } finally {
    await fh.close();
  }
}

export function _resetStatusCache() { statusCache.clear(); }
