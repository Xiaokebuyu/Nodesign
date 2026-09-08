/**
 * server/projects/folder.js — 文件夹项目（2026-09-07 存量仓库道，桌面版专用）
 *
 * 「打开本地文件夹」的服务端：用户在自己机器上指一个目录，这个目录就是项目。
 *
 *   - agent 的 cwd = 这个目录（跟原生 Claude Code 一样在仓库里干活）
 *   - 画布真相 = `<目录>/.nodesign/`（workspace.js 的 getWorkspaceRoot 按 folder_path 分流）
 *   - 身份跟着文件夹走：`.nodesign/project.json` 里的 id 是真身，projects 表那一行只是
 *     这台机器的索引。同一个文件夹搬了盘、换了机器、从 git 拉下来，打开时按 id 接回。
 *
 * 信任门：文件夹里的 `.claude/settings.json` 会被 SDK 当项目设置装载（settingSources
 * 'project'），里面的 hooks 是任意 shell 命令、permissions.allow 会放宽我们的闸。所以
 * 第一次打开先盘一遍，有东西就把答案留给用户（folder_trust NULL = 没答过，会话拒开）；
 * 什么都没有就直接算信任 —— 没有可决定的事就别弹框。跟 Claude Code 打开新目录时的
 * 「信任这个文件夹吗」是同一件事，不是我们发明的。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createProject, getProject, getProjectByFolder, rebindProjectFolder, updateProject,
} from './store.js';
import { ensureProjectWorkspace, NODESIGN_DIR, PROJECTS_DATA_ROOT } from './workspace.js';
import { initFolderIdentity } from './workspace-layout.js';

const PROJECT_ID_RE = /^proj_[a-z0-9_]{6,80}$/i;

/** 用户可能给的路径先规范化：去尾部分隔符、展开 ~、绝对化。Windows 下大小写不折叠（NTFS 不敏感但路径原样存）。 */
export function normalizeFolderPath(input) {
  if (typeof input !== 'string' || !input.trim()) throw folderError('FOLDER_PATH_REQUIRED', '要一个文件夹路径');
  let p = input.trim();
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
  p = path.resolve(p);
  // 根目录（/ 或 C:\）不能当项目：扫描器会把整块盘当画布
  if (path.dirname(p) === p) throw folderError('FOLDER_IS_ROOT', '不能把整块盘当项目');
  return p;
}

function folderError(code, message) {
  return Object.assign(new Error(message), { code, status: 400 });
}

/**
 * 盘一遍文件夹里会进 agent 会话的东西，给信任门看。
 * 只读不解释：hooks 原样列命令，allow 原样列规则，让用户自己判断。
 */
export async function inspectFolderTrust(folder) {
  const out = { hooks: [], allow: [], deny: 0, hasClaudeMd: false, hasMcpJson: false, hasSettings: false };
  out.hasClaudeMd = await exists(path.join(folder, 'CLAUDE.md'));
  out.hasMcpJson = await exists(path.join(folder, '.mcp.json'));
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = path.join(folder, '.claude', name);
    let json;
    try { json = JSON.parse(await fs.readFile(file, 'utf8')); } catch { continue; }
    out.hasSettings = true;
    for (const [event, matchers] of Object.entries(json?.hooks || {})) {
      for (const m of Array.isArray(matchers) ? matchers : []) {
        for (const h of Array.isArray(m?.hooks) ? m.hooks : []) {
          if (h?.command) out.hooks.push({ file: name, event, matcher: m.matcher || '', command: String(h.command) });
        }
      }
    }
    for (const rule of Array.isArray(json?.permissions?.allow) ? json.permissions.allow : []) {
      if (typeof rule === 'string') out.allow.push({ file: name, rule });
    }
    if (Array.isArray(json?.permissions?.deny)) out.deny += json.permissions.deny.length;
  }
  // 要用户拍板的只有会执行东西 / 放宽闸门的两类；CLAUDE.md 和 deny 只是告知
  out.needsDecision = out.hooks.length > 0 || out.allow.length > 0;
  return out;
}

/**
 * 打开一个文件夹当项目。幂等：同一个文件夹再开就是同一个项目。
 *
 * 接回顺序：① `.nodesign/project.json` 的 id 在库里 → 就是它（路径变了就改索引）
 *          ② 库里有这个路径 → 就是它 ③ 都没有 → 新建（有 project.json 就沿用它的 id）
 *
 * @returns {Promise<{ project: object, trust: object, created: boolean }>}
 */
export async function openFolder({ path: input, ownerId = null }) {
  const folder = normalizeFolderPath(input);
  // 先按路径判（不看盘）：数据目录和 .nodesign 本身不管存不存在都不能当项目
  const dataRoot = path.resolve(PROJECTS_DATA_ROOT);
  if (folder === dataRoot || folder.startsWith(dataRoot + path.sep)) {
    throw folderError('FOLDER_IS_DATA_ROOT', '这是 NoDesign 自己的数据目录，不能当项目打开');
  }
  if (path.basename(folder) === NODESIGN_DIR) {
    throw folderError('FOLDER_IS_NODESIGN_DIR', '这是某个项目的 .nodesign 目录，请打开它的上一层');
  }
  let st;
  try { st = await fs.stat(folder); } catch { throw folderError('FOLDER_NOT_FOUND', `找不到这个文件夹：${folder}`); }
  if (!st.isDirectory()) throw folderError('FOLDER_NOT_DIR', `不是文件夹：${folder}`);

  const identityFile = path.join(folder, NODESIGN_DIR, 'project.json');
  let identityId = null;
  try {
    const j = JSON.parse(await fs.readFile(identityFile, 'utf8'));
    if (typeof j?.id === 'string' && PROJECT_ID_RE.test(j.id)) identityId = j.id;
  } catch { /* 没有身份文件：第一次开 */ }

  let project = null;
  let created = false;
  if (identityId) {
    const known = getProject(identityId);
    if (known) {
      // 同一个身份指着别的路径 = 文件夹搬家了；指着这个路径 = 原地再开
      project = known.folderPath === folder ? known : rebindProjectFolder(identityId, folder);
    }
  }
  if (!project) project = getProjectByFolder(folder);
  if (!project) {
    project = createProject({
      name: path.basename(folder),
      ownerId,
      folderPath: folder,
      id: identityId || undefined,
    });
    created = true;
  }

  // 身份 + 首开快照 + 桌面在哪，都在 ensureProjectWorkspace 之前定：它一开工就要问 getWorkspaceRoot
  const { desk, baseline } = await initFolderIdentity(folder, project.id);
  const trust = await inspectFolderTrust(folder);
  // 没有要拍板的东西就直接算信任；有东西且没答过就留 null 等用户
  if (project.folderTrust == null && !trust.needsDecision) {
    project = updateProject(project.id, { folderTrust: true });
  }
  await ensureProjectWorkspace(project.id);
  return { project, trust, created, desk, baseline };
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}
