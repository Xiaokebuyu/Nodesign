/**
 * server/projects/workspace-layout.js — 工作区根上的两样纯文件系统地基（从 workspace.js 拆出，2026-09-07）
 *
 *   - ensureGitignore：工作区根的 .gitignore 按行合并默认条目（用户自己加的行原样保留）
 *   - ensureFolderProjectDir：文件夹项目的 `.nodesign/` 地基（存量仓库道）
 *
 * 两个都不认 projectId、不读库，只收路径 —— 所以能单测，也不会把 workspace.js 撑过行数棘轮。
 */

import { promises as fs } from 'fs';
import path from 'path';
import { DEFAULT_GITIGNORE } from './workspace-templates.js';

/** 文件夹项目里画布真相住的那个点目录（跟 .vscode / .idea 同一个惯例） */
export const NODESIGN_DIR = '.nodesign';

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
  const identity = path.join(root, 'project.json');
  if (!(await fileExists(identity))) {
    await fs.writeFile(identity, JSON.stringify({ id: projectId, createdAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  }
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

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}
