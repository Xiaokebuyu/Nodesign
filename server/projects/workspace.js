/**
 * server/projects/workspace.js — Per-project + per-session 文件系统 workspace
 *
 * H3：session-scoped 工作目录。每个 session 一个独立沙盒（含 canvas.html /
 * spec.json / .git），跨 session 共享 shared/.claude/ 配置和 shared/assets/。
 *
 * 结构：
 *   <PROJECTS_DATA_ROOT>/<projectId>/
 *     ├── shared/                    ← project 共享
 *     │   ├── .claude/
 *     │   │   ├── CLAUDE.md          ← 项目 instruction（用户写）
 *     │   │   ├── settings.json      ← 项目 SDK config
 *     │   │   ├── skills/            ← 项目级 skills
 *     │   │   ├── agents/            ← 项目级 subagents
 *     │   │   └── agent-memory/      ← 跨 session memory（agent 写）
 *     │   ├── assets/                ← 用户上传文件
 *     │   └── .gitignore
 *     └── sessions/<sid>/            ← session 独立沙盒
 *         ├── canvas.html
 *         ├── spec.json
 *         ├── .claude/
 *         │   ├── CLAUDE.md          ← softlink → ../../../shared/.claude/CLAUDE.md
 *         │   ├── settings.json      ← softlink → ../../../shared/.claude/settings.json
 *         │   ├── skills             ← softlink → ../../../shared/.claude/skills
 *         │   ├── agents             ← softlink → ../../../shared/.claude/agents
 *         │   ├── agent-memory       ← softlink → ../../../shared/.claude/agent-memory
 *         │   └── projects/<encoded-cwd>/<sid>.jsonl ← SDK 自动写转录
 *         └── .git/                  ← per-session history
 *
 * agent 跑 run 时 cwd 设到 sessions/<sid>/，SDK settingSources: ['project']
 * 通过软链拿到 shared/.claude/CLAUDE.md。assets 走 SDK additionalDirectories
 * 让 agent 能跨目录 Read。
 *
 * 边界：
 *   - validateProjectId / validateSessionId 防 traversal
 *   - git ops 走 child_process spawn（不开 shell，args 不被 shell 解释）
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

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SDK sessionId 必须 UUID 格式（防路径 traversal） */
export function validateSessionId(sid) {
  if (typeof sid !== 'string' || !SESSION_ID_RE.test(sid)) {
    throw Object.assign(new Error(`非法 sessionId: ${JSON.stringify(sid)}`), { code: 'INVALID_SESSION_ID' });
  }
}

const DEFAULT_GITIGNORE = `node_modules/
.DS_Store
*.log
.tmp/
`;

const DEFAULT_SPEC_JSON = JSON.stringify(
  { version: '0.1', meta: {}, designTokens: {}, outline: [] },
  null, 2,
) + '\n';

const DEFAULT_CLAUDE_MD = `# Project Instructions

This file is read by the AI agent at the start of every session as part of its
system prompt. Write project-specific guidance here — design intent,
constraints, vocabulary, must-do / must-not-do.

The agent will see this verbatim. Keep it concise and actionable.

## Examples
- Design tone: minimal, editorial, generous whitespace
- Hard constraints: never use red as a primary color
- Vocabulary: refer to the user as "the team"

(Edit this file from the NoDesign UI — the agent picks up changes on next session.)
`;

const DEFAULT_CLAUDE_SETTINGS = JSON.stringify(
  {
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    _comment: 'Project-level Claude Code settings. NoDesign loop.js injects hooks/permissions/sandbox programmatically — keep this file minimal. Add project-specific overrides here only if needed.',
  },
  null, 2,
) + '\n';

// 5 个共享子项软链名（CLAUDE.md / settings.json 是文件，其余是目录）
const SHARED_LINKS = ['CLAUDE.md', 'settings.json', 'skills', 'agents', 'agent-memory'];

// ── 路径 helpers ──

/** project workspace 根（不保证存在） */
export function getProjectWorkspace(projectId) {
  validateProjectId(projectId);
  return path.join(PROJECTS_DATA_ROOT, projectId);
}

/** project 共享配置 + 资源目录（shared/） */
export function getSharedDir(projectId) {
  return path.join(getProjectWorkspace(projectId), 'shared');
}

/** 单个 session 的工作目录（sessions/<sid>/） */
export function getSessionWorkspace(projectId, sessionId) {
  validateSessionId(sessionId);
  return path.join(getProjectWorkspace(projectId), 'sessions', sessionId);
}

// ── ensure ──

/**
 * 创建 project workspace（幂等）。完成后保证：
 *   - shared/.claude/{CLAUDE.md, settings.json} 模板写入（仅不存在时）
 *   - shared/.claude/{skills, agents, agent-memory} 目录存在（让 sessions 软链有效）
 *   - shared/assets/ 存在
 *   - shared/.gitignore 写入
 *
 * 不在此处 git init shared/ —— shared 内容（CLAUDE.md / assets）的版本管理走
 * NoDesign 业务层（用户改 CLAUDE.md 直接覆盖；H4 加 audit 再说）。
 *
 * 启动时先调 removeRootLegacyArtifacts 清掉老结构（用户决策"删了"）。
 */
export async function ensureProjectWorkspace(projectId) {
  await removeRootLegacyArtifacts(projectId);

  const shared = getSharedDir(projectId);
  await fs.mkdir(path.join(shared, '.claude', 'skills'), { recursive: true });
  await fs.mkdir(path.join(shared, '.claude', 'agents'), { recursive: true });
  await fs.mkdir(path.join(shared, '.claude', 'agent-memory'), { recursive: true });
  await fs.mkdir(path.join(shared, 'assets'), { recursive: true });

  if (!(await fileExists(path.join(shared, '.gitignore')))) {
    await fs.writeFile(path.join(shared, '.gitignore'), DEFAULT_GITIGNORE, 'utf8');
  }
  if (!(await fileExists(path.join(shared, '.claude', 'CLAUDE.md')))) {
    await fs.writeFile(path.join(shared, '.claude', 'CLAUDE.md'), DEFAULT_CLAUDE_MD, 'utf8');
  }
  if (!(await fileExists(path.join(shared, '.claude', 'settings.json')))) {
    await fs.writeFile(path.join(shared, '.claude', 'settings.json'), DEFAULT_CLAUDE_SETTINGS, 'utf8');
  }

  return getProjectWorkspace(projectId);
}

/**
 * 创建 session workspace（幂等）。完成后保证：
 *   - sessions/<sid>/.claude/projects/ 存在（SDK 落 JSONL 处）
 *   - sessions/<sid>/.claude/{CLAUDE.md, settings.json, skills, agents, agent-memory}
 *     是软链指向 shared/.claude/<name>（相对路径 ../../../shared/.claude/<name>）
 *   - sessions/<sid>/.git/ 已 init + empty commit
 *
 * 调用前需先 ensureProjectWorkspace（保证 shared/.claude 子目录存在让软链有效）。
 *
 * @returns {Promise<string>} sessions/<sid>/ 绝对路径
 */
export async function ensureSessionWorkspace(projectId, sessionId) {
  await ensureProjectWorkspace(projectId);

  const sessionRoot = getSessionWorkspace(projectId, sessionId);
  await fs.mkdir(path.join(sessionRoot, '.claude', 'projects'), { recursive: true });

  // 软链 shared/.claude/<name> → sessions/<sid>/.claude/<name>
  // 相对路径：从 sessions/<sid>/.claude/ 看 ../../../shared/.claude/<name>
  for (const name of SHARED_LINKS) {
    const link = path.join(sessionRoot, '.claude', name);
    if (await pathExists(link)) continue;
    const target = path.join('..', '..', '..', 'shared', '.claude', name);
    try {
      await fs.symlink(target, link);
    } catch (err) {
      // Windows 无 admin 权限会失败 —— 降级 cp（CLAUDE.md / settings.json 是文件）
      // skills/agents/agent-memory 是目录 —— Windows 上 fs.cp 也行，但失去"shared 改即 session 看到"语义。
      // 暂时只 warn，不阻塞（macOS / Linux 部署不会触发）
      console.warn(`[workspace] symlink failed for ${name} (${err.code || err.message}); session 将看不到 shared/<${name}>`);
    }
  }

  // per-session .git
  if (!(await fileExists(path.join(sessionRoot, '.git')))) {
    await runGit(sessionRoot, ['init', '-q', '-b', 'main']);
    await runGit(sessionRoot, ['add', '-A']);
    await runGit(sessionRoot, [
      '-c', 'user.email=nodesign@local',
      '-c', 'user.name=NoDesign',
      'commit', '-q', '--allow-empty', '-m', 'init',
    ]);
  }

  return sessionRoot;
}

// ── 老结构清理（用户决策"删了"）──

/**
 * 检测 project workspace 根有 canvas.html / spec.json / .git / .claude 这些
 * S1 时代的老 artifacts，且 shared/ 不存在 → 这是老结构 → 全删。
 *
 * 运行一次性，每个 project 第一次进入新代码时清理。idempotent。
 */
export async function removeRootLegacyArtifacts(projectId) {
  const root = getProjectWorkspace(projectId);
  if (!(await fileExists(root))) return;
  if (await fileExists(path.join(root, 'shared'))) return;

  // 只有当老 artifacts 至少一个存在时，认定是老 project
  const legacyTargets = ['canvas.html', 'spec.json', '.git', '.gitignore', '.claude', 'assets'];
  let hadLegacy = false;
  for (const name of legacyTargets) {
    if (await fileExists(path.join(root, name))) { hadLegacy = true; break; }
  }
  if (!hadLegacy) return;

  for (const name of legacyTargets) {
    const p = path.join(root, name);
    if (await fileExists(p)) {
      await fs.rm(p, { recursive: true, force: true });
    }
  }
  console.log(`[workspace] removed legacy root artifacts for ${projectId}`);
}

// ── 删除 ──

export async function removeProjectWorkspace(projectId) {
  const root = getProjectWorkspace(projectId);
  await fs.rm(root, { recursive: true, force: true });
}

/** 删 sessions/<sid>/ */
export async function removeSessionWorkspace(projectId, sessionId) {
  const sessionRoot = getSessionWorkspace(projectId, sessionId);
  await fs.rm(sessionRoot, { recursive: true, force: true });
}

// ── git ops（per-session）──

/**
 * 在 sessions/<sid>/.git 上 commit working tree。无改动 silent skip。
 */
export async function commitWorkspace(projectId, sessionId, message, { author = 'system' } = {}) {
  const sessionRoot = getSessionWorkspace(projectId, sessionId);
  if (!(await fileExists(sessionRoot))) return null;
  await runGit(sessionRoot, ['add', '-A']);
  const { stdout } = await runGit(sessionRoot, ['status', '--porcelain'], { capture: true });
  if (!stdout.trim()) return null;
  await runGit(sessionRoot, [
    '-c', `user.email=${author}@nodesign`,
    '-c', `user.name=${author}`,
    'commit', '-q', '-m', message,
  ]);
  const { stdout: hash } = await runGit(sessionRoot, ['rev-parse', 'HEAD'], { capture: true });
  return hash.trim();
}

export async function listHistory(projectId, sessionId, { limit = 50 } = {}) {
  const sessionRoot = getSessionWorkspace(projectId, sessionId);
  if (!(await fileExists(sessionRoot))) return [];
  const { stdout, code } = await runGit(
    sessionRoot,
    ['log', `--max-count=${limit}`, '--pretty=format:%H%x09%cI%x09%an%x09%s'],
    { capture: true },
  );
  if (code !== 0) return [];
  return stdout
    .trim().split('\n').filter(Boolean)
    .map((line) => {
      const [hash, isoDate, gitAuthor, ...msgParts] = line.split('\t');
      return { hash, date: isoDate, author: gitAuthor, message: msgParts.join('\t') };
    });
}

export async function revertWorkspace(projectId, sessionId, commitHash) {
  if (!/^[a-f0-9]{7,40}$/i.test(commitHash)) {
    throw Object.assign(new Error(`invalid commit hash: ${commitHash}`), { code: 'INVALID_COMMIT' });
  }
  const sessionRoot = getSessionWorkspace(projectId, sessionId);
  await runGit(sessionRoot, ['checkout', commitHash, '--', '.']);
  return commitWorkspace(projectId, sessionId, `revert to ${commitHash.slice(0, 7)}`, { author: 'user' });
}

// ── fork ──

/**
 * Fork session 时复制产物：cp -r sessions/<srcSid> → sessions/<newSid>，但
 * 跳过 .claude/projects（SDK 自己管 JSONL，新 sid 跟旧 sid 不同 jsonl）。
 *
 * 软链用 verbatim 复制（保留软链结构，相对路径 ../../../shared/<name> 在新
 * 目录下仍指向 shared，无需重建）。
 *
 * .git 一并复制 → newSid 继承 srcSid 完整 history（fork 语义"从这里继续"）。
 */
export async function forkSessionWorkspace(projectId, srcSessionId, newSessionId) {
  validateSessionId(srcSessionId);
  validateSessionId(newSessionId);
  const srcRoot = getSessionWorkspace(projectId, srcSessionId);
  const newRoot = getSessionWorkspace(projectId, newSessionId);

  if (!(await fileExists(srcRoot))) {
    throw Object.assign(new Error(`fork source session not found: ${srcSessionId}`), { code: 'SRC_NOT_FOUND' });
  }
  if (await fileExists(newRoot)) {
    throw Object.assign(new Error(`fork target session already exists: ${newSessionId}`), { code: 'TARGET_EXISTS' });
  }

  // 用 fs.cp recursive + verbatimSymlinks 保留软链结构。
  // filter 跳 .claude/projects（SDK 会写新 sid 的 JSONL 到这里，老 jsonl 别带）
  const skipPathSegment = path.join('.claude', 'projects');
  await fs.cp(srcRoot, newRoot, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      const rel = path.relative(srcRoot, src);
      // 顶层 + 路径不含 .claude/projects 的都复制
      return !rel.startsWith(skipPathSegment);
    },
  });

  // 确保 .claude/projects/ 存在（fs.cp filter 跳掉后没建）
  await fs.mkdir(path.join(newRoot, '.claude', 'projects'), { recursive: true });

  return newRoot;
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

async function pathExists(p) {
  // 区分 fileExists 用于"包括软链 dangling"的检查（lstat 不 follow）
  try {
    await fs.lstat(p);
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
