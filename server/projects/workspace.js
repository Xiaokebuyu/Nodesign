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

/**
 * NoDesign 全局默认 settings.json — 代码是 source of truth。
 *
 * 每次 ensureProjectWorkspace 都会跟 shared/.claude/settings.json merge
 * （existing 字段优先，新增 default 字段补上）。这样升级现存 project 不需要
 * 用户手动改文件。
 *
 * autoCompactEnabled / autoCompactWindow：
 *   2026-05-01 加 — Kimi gateway 上下文上限 256k（262144 tokens）。当前默认
 *   模型 kimi-k2.6 一旦 prompt 累积超 256k → gateway 直接 400 报错（用户实测
 *   request id 20260501104913995449543DV62Dl5F：requested 418547 tokens）。
 *   留 10% 阈值 → 230000 tokens 触发自动 compact，SDK 用同模型压缩对话历史。
 *   PostCompact hook（hooks.js:84）已就位，compact 后摘要写 spec.json 长期记忆。
 *   1M context 模型（如 claude-opus-4-7[1m]）使用时建议手动调高这个值。
 */
const DEFAULT_NODESIGN_SETTINGS = {
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  autoCompactEnabled: true,
  autoCompactWindow: 230000,
};

/**
 * Merge NoDesign defaults 到现存 settings.json（existing 字段优先）。
 * 文件不存在时直接落 defaults。
 *
 * @returns {Promise<boolean>} 是否有改动（true = 写入了，false = 完全相同跳过）
 */
async function mergeSettingsDefaults(settingsPath) {
  let existing = {};
  if (await fileExists(settingsPath)) {
    try {
      existing = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    } catch (err) {
      // 损坏的 JSON：保留备份后用 defaults 覆盖
      const backup = settingsPath + `.broken-${Date.now()}`;
      await fs.rename(settingsPath, backup).catch(() => {});
      console.warn(`[workspace] settings.json parse failed, backed up to ${backup}`);
      existing = {};
    }
  }
  const merged = { ...DEFAULT_NODESIGN_SETTINGS, ...existing };
  // 旧 _comment 字段不再写默认（曾经的 placeholder），用户自定义保留
  const before = JSON.stringify(existing);
  const after = JSON.stringify(merged);
  if (before === after) return false;
  await fs.writeFile(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return true;
}

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
  // settings.json：每次 merge defaults 让代码层 default 升级时现存 project 自动跟上
  // （用户字段优先，缺失的 NoDesign default 字段补进去）
  await mergeSettingsDefaults(path.join(shared, '.claude', 'settings.json'));

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
  //
  // C2c：之前软链失败仅 warn 不阻塞 —— 隐性损坏 path 系统（agent 写到 sessions
  // 本地真目录而不是 shared 软链下，前端 BrandCard / MemoryCard 读 shared 找不到，
  // 用户体感"写完消失"但 agent 报"成功"。
  // 改成 fail-loud：throw 让 ensureSessionWorkspace 失败前端能看到错。
  // env NODESIGN_ALLOW_SYMLINK_FALLBACK=1 强制降级 warn（Windows / 不支持
  // symlink 的边缘 docker volume 用）
  const allowSymlinkFallback = process.env.NODESIGN_ALLOW_SYMLINK_FALLBACK === '1';
  for (const name of SHARED_LINKS) {
    const link = path.join(sessionRoot, '.claude', name);
    if (await pathExists(link)) continue;
    const target = path.join('..', '..', '..', 'shared', '.claude', name);
    try {
      await fs.symlink(target, link);
    } catch (err) {
      const msg = `symlink failed for ${name} (${err.code || err.message}); session 将看不到 shared/<${name}>，agent 写 memory 会丢`;
      if (allowSymlinkFallback) {
        console.warn(`[workspace] ${msg}（NODESIGN_ALLOW_SYMLINK_FALLBACK=1，已降级 warn）`);
      } else {
        throw new Error(`[workspace] ${msg}。设 NODESIGN_ALLOW_SYMLINK_FALLBACK=1 强制降级（Windows / 部分 docker volume 不支持 symlink）`);
      }
    }
  }

  // sessions/<sid>/assets → ../../shared/assets/
  // 让 agent 用 prelude/SKILL.md 教的 `./assets/` 直接访问（Glob/Read），
  // 不必关心 ../../shared/ 内部结构。修 H3 session-scoped 重构后的路径漂移
  // —— 之前 prelude 教 `./assets/` 但实际路径是 `../../shared/assets/`，
  // Glob `assets/**/*` 永远返 0 让 agent 误以为没素材，连带 Read 图片也
  // 因 ENOENT 失败（用户报告的"Read 无法读取图片"）。
  //
  // 相对路径：从 sessions/<sid>/ 看 ../../shared/assets/（出 sid → 出 sessions → 入 shared）。
  // additionalDirectories 已含 sharedRoot（loop.js），软链只是给 agent 一个
  // 自然的 cwd-相对入口；权限走 SDK sandbox.allowRead。
  const assetsLink = path.join(sessionRoot, 'assets');
  if (!(await pathExists(assetsLink))) {
    try {
      await fs.symlink(path.join('..', '..', 'shared', 'assets'), assetsLink);
    } catch (err) {
      const msg = `assets symlink failed (${err.code || err.message}); agent 将看不到 ./assets/，curl 下载也会写到错位置`;
      if (allowSymlinkFallback) {
        console.warn(`[workspace] ${msg}（NODESIGN_ALLOW_SYMLINK_FALLBACK=1，已降级 warn）`);
      } else {
        throw new Error(`[workspace] ${msg}。设 NODESIGN_ALLOW_SYMLINK_FALLBACK=1 强制降级`);
      }
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

// ── workspace 主动提醒（C8 SKILL/prelude 改造）──
//
// 给 turn.js composeUserMessage 用 —— 检测 sessionRoot 下 assets/ 软链指向的
// shared/assets/ 是否有内容，有就让 agent 看见 "<system>workspace 里有 N 个文
// 件……" 提示。空目录就不注入，agent 不必每个 turn 都硬 Glob 一遍。
//
// 之前的设计：prelude 强制 agent 首跑前 Glob assets/**/* —— 浪费一次 turn 即便
// 目录是空的。改成 workspace 主动 prepend 提示，把"是否需要看 assets" 这个
// 决策从"agent 必须先做"翻译成"agent 看到提示自己判断"。

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const DOC_EXT = new Set(['.md', '.txt', '.pdf', '.json']);

/**
 * @param {string} sessionRoot - sessions/<sid>/ 绝对路径
 * @returns {Promise<{ count: number, summary: string }>}
 *   count=0 时 summary 为空字符串，调用方据此判断是否注入提示。
 *   summary 形如 "workspace 里已有 3 个素材（2 张图 cover.png/palette.jpg、1 个文档 brief.md）"
 */
export async function readAssetsSummary(sessionRoot) {
  try {
    const assetsLink = path.join(sessionRoot, 'assets');
    const stat = await fs.stat(assetsLink).catch(() => null);
    if (!stat) return { count: 0, summary: '' };

    const entries = await fs.readdir(assetsLink, { withFileTypes: true }).catch(() => []);
    const files = entries.filter((e) => !e.name.startsWith('.') && (e.isFile() || e.isSymbolicLink()));
    if (files.length === 0) return { count: 0, summary: '' };

    const images = [];
    const docs = [];
    const others = [];
    for (const f of files) {
      const ext = path.extname(f.name).toLowerCase();
      if (IMAGE_EXT.has(ext)) images.push(f.name);
      else if (DOC_EXT.has(ext)) docs.push(f.name);
      else others.push(f.name);
    }

    // 摘要：种类 + 头几个文件名（避免太长）
    const parts = [];
    if (images.length > 0) {
      const sample = images.slice(0, 3).join('、');
      parts.push(`${images.length} 张图（${sample}${images.length > 3 ? ` 等` : ''}）`);
    }
    if (docs.length > 0) {
      const sample = docs.slice(0, 3).join('、');
      parts.push(`${docs.length} 个文档（${sample}${docs.length > 3 ? ` 等` : ''}）`);
    }
    if (others.length > 0) {
      parts.push(`${others.length} 个其他文件`);
    }

    return {
      count: files.length,
      summary: `workspace 里已有 ${files.length} 个参考素材：${parts.join('、')}`,
    };
  } catch {
    return { count: 0, summary: '' };
  }
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
