/**
 * server/projects/workspace-layout.js — 工作区根上的两样纯文件系统地基（从 workspace.js 拆出，2026-09-07）
 *
 *   - ensureGitignore：工作区根的 .gitignore 按行合并默认条目（用户自己加的行原样保留）
 *   - ensureFolderProjectDir：文件夹项目的 `.nodesign/` 地基（存量仓库道）
 *   - deskRelOf / snapshotBaseline：**桌面在哪**（09-08 站主拍板「不分文件夹项目」之后的定法）
 *
 * ## 桌面在哪（09-08）
 *
 * 一个项目 = 一个文件夹，agent 站在文件夹里（cwd）。画布（桌面）在哪由**首开时文件夹空不空**决定：
 *   - 空文件夹：桌面就是文件夹本身（跟托管项目的 shared/ 一模一样：board.json / notes / assets /
 *     .claude 全在根上）。
 *   - 已经有东西的文件夹（用户的仓库）：桌面缩进 `.nodesign/`，用户的东西一个字不碰；仓库本身在
 *     桌面上是一张「仓库卡」（视图形态，不是文件夹卡 —— 拖进拖出不搬文件）。
 * 判定只做一次，写进 `.nodesign/project.json` 的 `desk` 字段（'.' | '.nodesign'），之后**从盘上读**，
 * 数据库不存第二份。首开那一刻根上有什么记进 `baseline.json`（仓库卡拿它标「我们来之后新增的」）。
 * ⛔ 不按内容动态判：文件夹后来装满了桌面也不能搬家，board.json 和产物都在原地。
 *
 * 两个都不认 projectId、不读库，只收路径 —— 所以能单测，也不会把 workspace.js 撑过行数棘轮。
 */

import { promises as fs, readFileSync } from 'fs';
import path from 'path';
import { DEFAULT_GITIGNORE } from './workspace-templates.js';

/** 文件夹项目里画布真相住的那个点目录（跟 .vscode / .idea 同一个惯例） */
export const NODESIGN_DIR = '.nodesign';
/** 首开快照：那一刻文件夹根上有什么（仓库卡据此标新增；desk 判定也看它空不空） */
export const BASELINE_FILE = 'baseline.json';
/** 桌面的两种位置：文件夹本身 / 文件夹里的 .nodesign */
export const DESK_SELF = '.';
export const DESK_NESTED = NODESIGN_DIR;
/** 操作系统随手落下的文件，不算「有东西」 */
const OS_JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

const deskCache = new Map();   // folder → '.' | '.nodesign'（project.json 只在首开写一次，缓存不会陈旧）

/**
 * 这个文件夹的桌面相对路径。读 `.nodesign/project.json` 的 `desk`；没有字段（09-07 那批老身份文件）
 * 或没有文件 = 缩进 .nodesign（保守：宁可把桌面缩进去也不能把用户仓库当桌面扫）。
 * 同步 + 缓存：getWorkspaceRoot 一轮里被叫几十次。
 */
export function deskRelOf(folder) {
  const hit = deskCache.get(folder);
  if (hit) return hit;
  let desk = DESK_NESTED;
  try {
    const j = JSON.parse(readFileSync(path.join(folder, NODESIGN_DIR, 'project.json'), 'utf8'));
    if (j?.desk === DESK_SELF) desk = DESK_SELF;
  } catch { /* 没有身份文件：按缩进算 */ }
  deskCache.set(folder, desk);
  return desk;
}

export function deskRootOf(folder) {
  const desk = deskRelOf(folder);
  return desk === DESK_SELF ? folder : path.join(folder, desk);
}

/** 测试 / 首开写完身份文件后清缓存 */
export function forgetDesk(folder) { if (folder) deskCache.delete(folder); else deskCache.clear(); }

/**
 * 首开快照：根上除 `.nodesign` 和系统垃圾之外的条目。空数组 = 空文件夹。
 * ⚠️ `.git` 算「有东西」：一个刚 clone 的空仓库也是用户的仓库，桌面照样缩进去，
 *    不然 .gitignore 模板和 .claude/ 会写进他的仓库。
 */
export async function snapshotBaseline(folder) {
  let entries;
  try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(e => e.name !== NODESIGN_DIR && !OS_JUNK.has(e.name))
    .map(e => ({ name: e.name, dir: e.isDirectory() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 首开：写身份文件（id + desk）和快照。已有身份文件时**只补缺字段**（老文件没有 desk 就按缩进补上），
 * 已有快照不重拍 —— 快照的意义就是「我们来之前」，第二次开时盘上已经有我们的东西了。
 * @returns {Promise<{desk:string, baseline:Array}>}
 */
export async function initFolderIdentity(folder, projectId) {
  const dir = path.join(folder, NODESIGN_DIR);
  await fs.mkdir(dir, { recursive: true });
  const identityFile = path.join(dir, 'project.json');
  const baselineFile = path.join(dir, BASELINE_FILE);
  let identity = null;
  try { identity = JSON.parse(await fs.readFile(identityFile, 'utf8')); } catch { /* 首开 */ }
  let baseline = null;
  try { baseline = JSON.parse(await fs.readFile(baselineFile, 'utf8')); } catch { /* 首开 */ }
  if (!Array.isArray(baseline?.entries)) {
    baseline = { at: new Date().toISOString(), entries: await snapshotBaseline(folder) };
    await fs.writeFile(baselineFile, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  }
  const fresh = !identity || typeof identity !== 'object';
  if (fresh) identity = { id: projectId, createdAt: new Date().toISOString() };
  if (identity.desk !== DESK_SELF && identity.desk !== DESK_NESTED) {
    // 首开按快照定；09-07 那批老身份文件没有 desk 字段，它们全是缩进布局
    identity.desk = fresh && baseline.entries.length === 0 ? DESK_SELF : DESK_NESTED;
    await fs.writeFile(identityFile, JSON.stringify(identity, null, 2) + '\n', 'utf8');
  }
  forgetDesk(folder);
  return { desk: identity.desk, baseline: baseline.entries };
}

/**
 * .gitignore：保证 DEFAULT_GITIGNORE 里每一条都在，用户自己加的行原样保留。
 * 按行合并而不是整文件覆盖 —— 有人会往里加自己的规则。
 */
export async function ensureGitignore(file) {
  let existing = '';
  try { existing = await fs.readFile(file, 'utf8'); } catch { /* 还没有 */ }
  const have = new Set(existing.split('\n').map(l => l.trim()));
  const missing = DEFAULT_GITIGNORE.split('\n').filter(l => l.trim() && !have.has(l.trim()));
  if (!missing.length && existing) return;
  const merged = existing
    ? `${existing.replace(/\n*$/, '\n')}${missing.join('\n')}\n`
    : DEFAULT_GITIGNORE;
  await fs.writeFile(file, merged, 'utf8');
}

/**
 * 文件夹项目的 `.nodesign/` 地基（幂等）：
 *   - 目录本身
 *   - `project.json`：项目身份跟着文件夹走。搬盘、换机器、从 git 拉下来，打开时认出
 *     id 就接回原项目；数据库那一行只是这台机器的索引。已有的文件一字不动。
 *   - 父目录是 git 仓库时把 `.nodesign/` 写进 `.git/info/exclude`（本地排除，不碰他
 *     跟踪中的 .gitignore）。父目录不是仓库就什么都不做。
 */
export async function ensureFolderProjectDir(folder, root, projectId) {
  await fs.mkdir(root, { recursive: true });
  await initFolderIdentity(folder, projectId);
  await ensureGitExclude(folder);
}

/**
 * 父目录是 git 仓库时把 `.nodesign/` 写进 `.git/info/exclude`（本地排除，不碰他跟踪中的 .gitignore）。
 * 不是仓库就什么都不做。桌面 = 文件夹本身的项目会在 ensureProjectGit 之后再叫一次 —— 那时 .git 才有。
 */
export async function ensureGitExclude(folder) {
  const gitDir = path.join(folder, '.git');
  let isRepo = false;
  try { isRepo = (await fs.stat(gitDir)).isDirectory(); } catch { /* 不是仓库 */ }
  if (!isRepo) return;
  const excludeFile = path.join(gitDir, 'info', 'exclude');
  let existing = '';
  try { existing = await fs.readFile(excludeFile, 'utf8'); } catch { /* 没有就建 */ }
  const line = `${NODESIGN_DIR}/`;
  if (existing.split('\n').some(l => l.trim() === line || l.trim() === NODESIGN_DIR)) return;
  await fs.mkdir(path.dirname(excludeFile), { recursive: true });
  await fs.writeFile(excludeFile, `${existing.replace(/\n*$/, existing ? '\n' : '')}${line}\n`, 'utf8');
}
