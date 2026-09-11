/**
 * server/projects/repo.js — 仓库卡的后端（2026-09-08 存量仓库道·第二段）
 *
 * 用户的文件夹在画布上是一张**仓库卡**：桌面缩进 `.nodesign/` 之后，他的东西不在桌面上，
 * 这张卡是看向文件夹的一扇窗。三件事：
 *   - summary：分支 / 上次提交 / 改动计数（没有 git 就只有名字和首开快照）
 *   - tree：列一层目录，每条带 git 状态（子目录聚合成「里面有几处改动」）
 *   - file：读一份文本文件给代码阅读器（512KB 封顶，二进制不读）
 *
 * ⛔ 看的那半是只读的：仓库卡不搬文件、不改文件 —— 改动是 agent 在 cwd 里做的，这里只是看。
 *    唯一会写工作树的是文件底下的「回到这轮之前」（revertToTurn），而且只还原快照里有的路径。
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
import { capabilityState } from '../runtime/capabilities.js';
import { docPdf } from '../lib/docx-pages.js';

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
export async function gitStatusMap(folder, { fresh = false } = {}) {
  const hit = statusCache.get(folder);
  if (!fresh && hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.data;
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

/** 仓库窗能原样送给浏览器看的类型（pdf 用内置阅读器，图/音/视频用标签）。html/svg 不在这里：同源跑脚本 */
const RAW_MIME = {
  '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};
/** 原样送出：{ abs, mime }。类型不在表里 → 415 */
export async function repoRawFile(projectId, rel) {
  const folder = repoFolderOf(projectId);
  if (!folder) throw repoError('NOT_REPO_PROJECT', '这个项目没有仓库卡', 404);
  const { abs, rel: clean } = await resolveInside(folder, rel);
  const mime = RAW_MIME[path.extname(clean).toLowerCase()];
  if (!mime) throw repoError('REPO_RAW_TYPE', '这种文件不能原样预览', 415);
  let st;
  try { st = await fs.stat(abs); } catch { throw repoError('REPO_NOT_FOUND', '没有这个文件', 404); }
  if (!st.isFile()) throw repoError('REPO_NOT_FILE', '不是文件');
  return { abs, mime, size: st.size };
}

/** word 转成 PDF 给内置阅读器看。要 LibreOffice；没有回 501 让前端说清楚 */
export async function repoDocPdf(projectId, rel) {
  const folder = repoFolderOf(projectId);
  if (!folder) throw repoError('NOT_REPO_PROJECT', '这个项目没有仓库卡', 404);
  const { abs, rel: clean } = await resolveInside(folder, rel);
  if (!/\.(docx|doc|odt|pptx|ppt|xlsx|xls)$/i.test(clean)) throw repoError('REPO_RAW_TYPE', '不是能转 PDF 的文档', 415);
  const lo = capabilityState('libreoffice');
  if (lo && !lo.available) throw repoError('NO_LIBREOFFICE', lo.fix ? `这台机器没有 LibreOffice，装了才能预览：${lo.fix}` : '这台机器没有 LibreOffice，装了才能预览', 501);
  return docPdf(abs);
}

export function _resetStatusCache() { statusCache.clear(); }

// ── 改道安全网：每轮开工前拍快照，改坏了一键回到这轮之前（2026-09-08）──
//
// 快照 = 一棵 git tree 对象（临时索引里 `add -A` 再 `write-tree`），**不碰用户的索引和 HEAD**，
// 未跟踪文件也在里面（.gitignore 照常生效；.nodesign/ 在 info/exclude 里，桌面不进快照）。
// 回退 = 拿快照和现在的差异（再拍一棵树做 diff-tree），改过/删了的 `git restore --source=<tree>` 回来，
// 这轮新建的删掉。只动工作树，不动索引。
// 记录住 `.nodesign/turns.json`（最近 TURNS_KEEP 轮）：{ runId, sessionId, tree, startedAt, endedAt, changed }。

export const TURNS_FILE = 'turns.json';
const TURNS_KEEP = 40;
const pendingStarts = new Map();   // runId → Promise（startTurn 是同步的，快照在后台拍，结算时等它）

async function withTempIndex(folder, fn) {
  const tmp = path.join(folder, '.git', `nd-index-${process.pid}-${Date.now()}`);
  try { return await fn({ ...process.env, GIT_INDEX_FILE: tmp }); } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
}

function gitEnv(cwd, args, env, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); } catch { resolve(null); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', code => { clearTimeout(timer); resolve(code === 0 ? out : null); });
  });
}

/**
 * 快照与回退要**原样搬字节**，不能让用户的换行符配置插手（09-11）：core.autocrlf=true（Git for Windows
 * 安装器的默认）下，add 把 CRLF 收成 LF、restore 再按配置写成 CRLF —— 原本 LF 的文件回退完变成 CRLF。
 * 只关 autocrlf 这一个：仓库自己 .gitattributes 里声明的 text/eol 照旧生效（那是仓库对换行符的约定）。
 * 分支纪律那几条（接手提交、切分支）不走这个，它们是在用户的仓库里正常提交，按用户的配置来。
 */
const RAW_BYTES = ['-c', 'core.autocrlf=false'];

/** 工作树现在的样子拍成一棵 tree；不是 git 仓库或失败回 null */
export async function snapshotTree(folder) {
  if (!(await isGitRepo(folder))) return null;
  return withTempIndex(folder, async (env) => {
    // 先把 HEAD 读进临时索引（有 HEAD 的话），再 add -A：这样删除也能体现，空仓库也不炸
    await gitEnv(folder, ['read-tree', 'HEAD'], env);
    if ((await gitEnv(folder, [...RAW_BYTES, 'add', '-A', '--', '.'], env)) == null) return null;
    const tree = await gitEnv(folder, ['write-tree'], env);
    return tree ? tree.trim() : null;
  });
}

/** 快照 tree 到现在的差异：[{ rel, status:'M'|'A'|'D'|'R' }] */
export async function changedSince(folder, tree) {
  const now = await snapshotTree(folder);
  if (!now || !tree) return [];
  if (now === tree) return [];
  const raw = await gitEnv(folder, ['diff-tree', '-r', '-z', '--name-status', '--no-renames', tree, now], process.env);
  if (raw == null) return [];
  const parts = raw.split('\0');
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]; const rel = parts[i + 1];
    if (!status || !rel) continue;
    out.push({ rel: rel.replace(/\\/g, '/'), status: status[0] });
  }
  return out;
}

async function turnsPath(folder) { return path.join(folder, NODESIGN_DIR, TURNS_FILE); }
async function readTurns(folder) {
  try { const j = JSON.parse(await fs.readFile(await turnsPath(folder), 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; }
}
async function writeTurns(folder, turns) {
  await fs.mkdir(path.join(folder, NODESIGN_DIR), { recursive: true });
  await fs.writeFile(await turnsPath(folder), JSON.stringify(turns.slice(-TURNS_KEEP), null, 2) + '\n', 'utf8');
}

/** 回合开工：拍快照记一笔。不是仓库项目就什么都不做。同步返回，快照在后台拍。 */
export function recordTurnStart(projectId, { runId, sessionId = null } = {}) {
  const folder = repoFolderOf(projectId);
  if (!folder || !runId) return;
  const p = (async () => {
    const tree = await snapshotTree(folder);
    if (!tree) return;
    const turns = await readTurns(folder);
    turns.push({ runId, sessionId, tree, startedAt: new Date().toISOString(), endedAt: null, changed: [] });
    await writeTurns(folder, turns);
  })().catch(err => console.warn('[repo] turn snapshot failed:', err?.message || err));
  pendingStarts.set(runId, p);
}

/** 回合结束：算这轮改了什么，写回记录。返回改动清单（给事件/摘要用）。 */
export async function recordTurnEnd(projectId, runId) {
  const folder = repoFolderOf(projectId);
  if (!folder || !runId) return null;
  await pendingStarts.get(runId);
  pendingStarts.delete(runId);
  const turns = await readTurns(folder);
  const rec = turns.find(t => t.runId === runId);
  if (!rec) return null;
  rec.changed = await changedSince(folder, rec.tree);
  rec.endedAt = new Date().toISOString();
  statusCache.delete(folder);
  await writeTurns(folder, turns);
  return rec.changed;
}

/** 最近的回合（新的在前），只给前端要的字段 */
export async function listTurns(projectId, { limit = 8 } = {}) {
  const folder = repoFolderOf(projectId);
  if (!folder) return [];
  const turns = await readTurns(folder);
  return turns.slice(-limit).reverse().map(t => ({
    runId: t.runId, sessionId: t.sessionId, startedAt: t.startedAt, endedAt: t.endedAt, changed: t.changed || [],
  }));
}

/**
 * 回到某一轮开工之前：这轮之后（含之后所有轮）改过的文件全部还原。
 * 只动工作树。返回还原了哪些。
 */
export async function revertToTurn(projectId, runId) {
  const folder = repoFolderOf(projectId);
  if (!folder) throw repoError('NOT_REPO_PROJECT', '这个项目没有仓库卡', 404);
  const turns = await readTurns(folder);
  const rec = turns.find(t => t.runId === runId);
  if (!rec?.tree) throw repoError('TURN_NOT_FOUND', '没有这一轮的快照', 404);
  const changed = await changedSince(folder, rec.tree);
  const restore = changed.filter(c => c.status !== 'A').map(c => c.rel);
  const remove = changed.filter(c => c.status === 'A').map(c => c.rel);
  if (restore.length) {
    const ok = await gitEnv(folder, [...RAW_BYTES, 'restore', '--source', rec.tree, '--worktree', '--', ...restore], process.env, { timeoutMs: 60000 });
    if (ok == null) throw repoError('REVERT_FAILED', 'git restore 失败', 500);
  }
  for (const rel of remove) {
    const { abs } = await resolveInside(folder, rel).catch(() => ({ abs: null }));
    if (abs) await fs.rm(abs, { force: true }).catch(() => {});
  }
  statusCache.delete(folder);
  return { restored: restore, removed: remove };
}

// ── 分支纪律（09-08 站主定）：改之前工作树要干净，而且在 NoDesign 自己的分支上，不在 main 上改 ──
//
// 每轮开工前（turn.js 收到请求、起 run 之前）机器跑一遍：
//   没 git → init + 把 HARD_IGNORE_DIRS 和 .nodesign 写进 info/exclude + 把现状提交成「NoDesign 接手前的样子」
//   已在 nodesign/* 分支 → 什么都不做
//   工作树不干净 → 不切（切了会把他的改动一起带走，谁的都分不清），交给状态块让 agent 先问
//   干净 → `git switch -c nodesign/<yyyymmdd-hhmm>`
// 只在这里做一次判断、结果回给调用方和状态块；agent 那边照状态块的话行事。

export const WORK_BRANCH_PREFIX = 'nodesign/';

async function gitOk(folder, args, opts) {
  return (await gitEnv(folder, args, process.env, opts)) != null;
}

async function ensureLocalExclude(folder) {
  const excludeFile = path.join(folder, '.git', 'info', 'exclude');
  let existing = '';
  try { existing = await fs.readFile(excludeFile, 'utf8'); } catch { /* 没有就建 */ }
  const have = new Set(existing.split('\n').map(l => l.trim()));
  const want = [`${NODESIGN_DIR}/`, ...[...HARD_IGNORE_DIRS].map(d => `${d}/`)].filter(l => !have.has(l));
  if (!want.length) return;
  await fs.mkdir(path.dirname(excludeFile), { recursive: true });
  await fs.writeFile(excludeFile, `${existing.replace(/\n*$/, existing ? '\n' : '')}${want.join('\n')}\n`, 'utf8');
}

function workBranchName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${WORK_BRANCH_PREFIX}${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/**
 * @returns {Promise<null|{ action:'none'|'init'|'branched'|'dirty'|'already'|'failed', branch:string|null, dirty:number, note?:string }>}
 *   null = 不是仓库项目
 */
export async function ensureWorkBranch(projectId) {
  const folder = repoFolderOf(projectId);
  if (!folder) return null;
  const out = { action: 'none', branch: null, dirty: 0 };
  try {
    if (!(await isGitRepo(folder))) {
      if (!(await gitOk(folder, ['init', '-q', '-b', 'main']))) return { ...out, action: 'failed', note: 'git init 失败' };
      await ensureLocalExclude(folder);
      await gitOk(folder, ['add', '-A', '--', '.'], { timeoutMs: 120000 });
      await gitOk(folder, ['-c', 'user.email=nodesign@local', '-c', 'user.name=NoDesign', 'commit', '-q', '--allow-empty', '-m', 'NoDesign 接手前的样子'], { timeoutMs: 120000 });
      out.action = 'init';
    }
    await ensureLocalExclude(folder);
    statusCache.delete(folder);
    const status = await gitStatusMap(folder, { fresh: true });
    out.dirty = status ? status.size : 0;
    const branch = ((await gitEnv(folder, ['rev-parse', '--abbrev-ref', 'HEAD'], process.env)) || '').trim();
    out.branch = branch || null;
    if (branch.startsWith(WORK_BRANCH_PREFIX)) return { ...out, action: out.action === 'init' ? 'init' : 'already' };
    if (out.dirty > 0) return { ...out, action: 'dirty' };
    // 空仓库（还没有任何提交）切不了分支：先落一个空提交当根
    if (!(await gitOk(folder, ['rev-parse', '--verify', 'HEAD']))) {
      await gitOk(folder, ['-c', 'user.email=nodesign@local', '-c', 'user.name=NoDesign', 'commit', '-q', '--allow-empty', '-m', 'NoDesign 接手前的样子']);
    }
    const name = workBranchName();
    if (!(await gitOk(folder, ['switch', '-q', '-c', name]))) return { ...out, action: 'failed', note: '开分支失败' };
    statusCache.delete(folder);
    return { ...out, action: 'branched', branch: name };
  } catch (err) {
    return { ...out, action: 'failed', note: err?.message || String(err) };
  }
}
