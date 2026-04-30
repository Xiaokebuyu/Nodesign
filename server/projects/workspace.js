/**
 * server/projects/workspace.js — Per-project 文件系统 workspace
 *
 * 每个 project 一个独立目录：
 *   <PROJECTS_DATA_ROOT>/<projectId>/
 *     ├── canvas.html           ← 主产物（agent / 用户都直接改）
 *     ├── spec.json             ← agent 私域设计意图档案
 *     ├── assets/               ← 用户上传文件
 *     ├── .claude/skills/       ← project local skill 覆盖（P0 暂不暴露 UI）
 *     ├── .gitignore
 *     └── .git/                 ← history（用户直改 + agent edit 都 commit）
 *
 * agent 跑 run 时 cwd 设到这里 → SDK 内置 Read/Write/Edit/Bash 自动定位到 project workspace。
 *
 * 边界：
 *   - 路径通过 store.validateProjectId 防 traversal
 *   - git ops 走 child_process spawn（不开 shell，args 不会被 shell 解释）
 */

import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateProjectId } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECTS_DATA_ROOT = path.resolve(
  process.env.PROJECTS_DATA_DIR || path.join(__dirname, '../projects-data'),
);

const DEFAULT_GITIGNORE = `node_modules/
.DS_Store
*.log
.tmp/
`;

const DEFAULT_SPEC_JSON = JSON.stringify(
  {
    version: '0.1',
    meta: {},
    designTokens: {},
    outline: [],
  },
  null,
  2,
) + '\n';

/** 该 project 的 workspace 绝对路径（不保证存在） */
export function getProjectWorkspace(projectId) {
  validateProjectId(projectId);
  return path.join(PROJECTS_DATA_ROOT, projectId);
}

/**
 * 创建 workspace（幂等）。完成后保证：
 *   - workspace 目录 + assets/ + .claude/skills/ 存在
 *   - .gitignore 写入（只在不存在时）
 *   - spec.json 占位（只在不存在时）
 *   - .git 已 init 且有一条 init commit（只在不存在时）
 *
 * 不预创建 canvas.html —— 交给 agent 第一次写。
 *
 * @returns {Promise<string>} 绝对路径
 */
export async function ensureProjectWorkspace(projectId) {
  const root = getProjectWorkspace(projectId);
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });
  await fs.mkdir(path.join(root, '.claude', 'skills'), { recursive: true });

  if (!(await fileExists(path.join(root, '.gitignore')))) {
    await fs.writeFile(path.join(root, '.gitignore'), DEFAULT_GITIGNORE, 'utf8');
  }
  if (!(await fileExists(path.join(root, 'spec.json')))) {
    await fs.writeFile(path.join(root, 'spec.json'), DEFAULT_SPEC_JSON, 'utf8');
  }

  if (!(await fileExists(path.join(root, '.git')))) {
    await runGit(root, ['init', '-q', '-b', 'main']);
    await runGit(root, ['add', '.']);
    await runGit(root, [
      '-c', 'user.email=nodesign@local',
      '-c', 'user.name=NoDesign',
      'commit', '-q', '-m', 'init',
    ]);
  }

  return root;
}

/**
 * 删除整个 project workspace。
 * ⚠️ 仅在 deleteProject 级联清理时调用。
 */
export async function removeProjectWorkspace(projectId) {
  const root = getProjectWorkspace(projectId);
  await fs.rm(root, { recursive: true, force: true });
}

/**
 * 把当前 working tree 的所有改动 commit 出来。
 * 没改动时 silent skip（返回 null）。
 *
 * @param {string} message     commit 消息
 * @param {object} [opts]
 * @param {string} [opts.author='system']  仅作 git author 名前缀，不入鉴权
 * @returns {Promise<string|null>} 新 commit 的 sha；无改动返 null
 */
export async function commitWorkspace(projectId, message, { author = 'system' } = {}) {
  const root = getProjectWorkspace(projectId);
  await runGit(root, ['add', '-A']);
  const { stdout } = await runGit(root, ['status', '--porcelain'], { capture: true });
  if (!stdout.trim()) return null;
  await runGit(root, [
    '-c', `user.email=${author}@nodesign`,
    '-c', `user.name=${author}`,
    'commit', '-q', '-m', message,
  ]);
  const { stdout: hash } = await runGit(root, ['rev-parse', 'HEAD'], { capture: true });
  return hash.trim();
}

/** git log（每行一条） */
export async function listHistory(projectId, { limit = 50 } = {}) {
  const root = getProjectWorkspace(projectId);
  const { stdout, code } = await runGit(
    root,
    ['log', `--max-count=${limit}`, '--pretty=format:%H%x09%cI%x09%an%x09%s'],
    { capture: true },
  );
  if (code !== 0) return [];
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, isoDate, gitAuthor, ...msgParts] = line.split('\t');
      return { hash, date: isoDate, author: gitAuthor, message: msgParts.join('\t') };
    });
}

/**
 * 回滚到某个 commit（不 reset HEAD，而是 checkout 那个 commit 的文件 + 创建新 commit）。
 * 这样 history 链是单调的，不会破坏既有历史。
 */
export async function revertWorkspace(projectId, commitHash) {
  if (!/^[a-f0-9]{7,40}$/i.test(commitHash)) {
    throw Object.assign(new Error(`invalid commit hash: ${commitHash}`), { code: 'INVALID_COMMIT' });
  }
  const root = getProjectWorkspace(projectId);
  await runGit(root, ['checkout', commitHash, '--', '.']);
  return commitWorkspace(projectId, `revert to ${commitHash.slice(0, 7)}`, { author: 'user' });
}

// ── helpers ──

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function runGit(cwd, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (capture) resolve({ code, stdout, stderr });
      else if (code === 0) resolve({ code });
      else reject(new Error(`git ${args.join(' ')} failed (code=${code})`));
    });
  });
}
