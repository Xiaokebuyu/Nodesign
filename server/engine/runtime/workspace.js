/**
 * engine/runtime/workspace.js — 每个 run 一个沙盒目录
 *
 * 设计要点：
 *   - 每个 run 独占 `<WORKSPACE_DIR>/<runId>/workspace/`
 *   - 所有 tool（read_file / write_file / list_dir）必须经 safeResolve 校验路径，
 *     绝不能让 agent 写到 workspace 之外（包括 `..` 越界、绝对路径、symlink 跳出）
 *   - 不放敏感数据：env、token 都不进 workspace；只放 skill 产物 + 中间文件
 *   - WORKSPACE_DIR 默认 server/runs/，可通过 env 覆盖（部署时可能挂载到独立 volume）
 *
 * 不在这层做的事：
 *   - 真正的 chroot / cgroup 沙盒：MVP 是 trust-but-verify，工具层做严格 path 校验，
 *     但不防 Node.js 进程内的反射攻击（agent 不能直接写 JS 调 fs，工具层是唯一入口）
 *   - 资源配额（disk quota / cpu）：等 P3 接入 playwright 后再考虑
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 所有 workspace 的根目录（绝对路径）*/
export const WORKSPACE_ROOT = path.resolve(
  process.env.WORKSPACE_DIR || path.join(__dirname, '../../runs')
);

// ── runId 校验（防止把恶意字符当目录名）──

const RUN_ID_RE = /^run_[a-z0-9_]{6,80}$/i;

function validateRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    throw new Error(`非法 runId: ${JSON.stringify(runId)}`);
  }
}

// ── 路径辅助 ──

/** 该 run 的 workspace 绝对路径（不保证存在）*/
export function getWorkspaceRoot(runId) {
  validateRunId(runId);
  return path.join(WORKSPACE_ROOT, runId, 'workspace');
}

/** 该 run 的 run-level 目录（workspace 的父目录），未来可放 logs/ events.jsonl 等 */
export function getRunRoot(runId) {
  validateRunId(runId);
  return path.join(WORKSPACE_ROOT, runId);
}

/**
 * 创建 workspace（幂等）。返回 workspace 绝对路径。
 */
export async function ensureWorkspace(runId) {
  const root = getWorkspaceRoot(runId);
  await fs.mkdir(root, { recursive: true });
  return root;
}

/**
 * 把相对路径解析成 workspace 内的绝对路径，并校验越界。
 *
 * 规则：
 *   - relativePath 必须是非空字符串
 *   - 解析后必须严格落在 workspace root 下（path.relative 不能以 .. 开头 / 不能是绝对）
 *   - 不接受空串、'.'、'/'、绝对路径作为目标（避免歧义）
 *
 * @returns {string} 解析后的绝对路径
 * @throws {Error}  路径越界 / 非法
 */
export function safeResolve(runId, relativePath) {
  const root = getWorkspaceRoot(runId);
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error(`safeResolve: 相对路径必须为非空字符串，收到 ${JSON.stringify(relativePath)}`);
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error(`safeResolve: 不接受绝对路径 ${relativePath}`);
  }
  const target = path.resolve(root, relativePath);
  const rel = path.relative(root, target);
  // path.relative 在 target 等于 root 时返回 ''；MVP 也禁止（语义不明）
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`safeResolve: 路径越界或指向 workspace 自身: ${relativePath}`);
  }
  return target;
}

// ── 文件操作（薄包装，让 tool 层不直接 import fs）──

/**
 * 读文件文本内容。
 * @param {string} runId
 * @param {string} relativePath
 * @returns {Promise<string>}
 */
export async function readFile(runId, relativePath) {
  const abs = safeResolve(runId, relativePath);
  return fs.readFile(abs, 'utf8');
}

/**
 * 写文件（覆盖）；自动 mkdir 父目录。
 * @returns {Promise<{ bytes: number, path: string }>}
 */
export async function writeFile(runId, relativePath, content) {
  const abs = safeResolve(runId, relativePath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const buf = Buffer.from(content, 'utf8');
  await fs.writeFile(abs, buf);
  return { bytes: buf.length, path: relativePath };
}

/**
 * 列目录（一层；不递归）。返回 [{ name, type: 'file'|'dir', size? }]
 * 不存在则返回 []（不抛）—— 让 agent 第一次访问空 workspace 不必先 try/catch
 */
export async function listDir(runId, relativePath = '.') {
  const root = getWorkspaceRoot(runId);
  // '.' 单独处理：列 workspace 根
  const abs = relativePath === '.' ? root : safeResolve(runId, relativePath);
  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const e of entries) {
    const item = { name: e.name, type: e.isDirectory() ? 'dir' : 'file' };
    if (e.isFile()) {
      try {
        const stat = await fs.stat(path.join(abs, e.name));
        item.size = stat.size;
      } catch { /* ignore */ }
    }
    out.push(item);
  }
  return out;
}

/**
 * 检查文件是否存在。返回 boolean。
 */
export async function exists(runId, relativePath) {
  try {
    const abs = safeResolve(runId, relativePath);
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * 清理整个 run（workspace + run root）。MVP 不主动调用，留给将来的清理任务。
 * ⚠️ 注意：rm -rf 等价；只通过 runId 匹配防误删
 */
export async function removeRun(runId) {
  validateRunId(runId);
  const root = getRunRoot(runId);
  await fs.rm(root, { recursive: true, force: true });
}
