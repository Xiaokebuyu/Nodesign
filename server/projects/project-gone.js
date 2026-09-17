/**
 * server/projects/project-gone.js — 「项目已被删除」的存在性闸（09-17，问题库 iss_mtjex6wv_5xhn）
 *
 * 09-02 事故的后半段：用户删了项目，agent 的回合还在跑，`write_on_board → writeBoard →
 * ensureProjectWorkspace` 把已删项目的工作区整套重建出来（带一条 init 提交），看上去像「系统把工作区清空了」。
 * 所以会建目录 / 写画布的入口先问这里：项目行不在、或已进回收站，一律抛 PROJECT_GONE，
 * 报错文案直接写给 agent 看（MCP 工具抛出的错误原文会作为工具结果回到模型）。
 *
 * 行不在（absent）的判法有一个测试口子：服务端测试大量直接拿假 pid 调 ensureProjectWorkspace / patchBoard，
 * 不建项目行。`NODESIGN_ROWLESS_PROJECTS=allow`（只在 vitest.server.setup.js 和离线检查脚本里设）时，
 * 无行的 pid 当活项目，**除非**审计账里记过它被删 —— 已软删除的行在任何模式下都拦。生产不设这个变量。
 */
import path from 'node:path';
import { projectRowState } from './store.js';
import { hasDeletionRecord } from './deletion-log.js';
import { PROJECTS_DATA_ROOT } from './workspace.js';   // 循环依赖：只在函数体里读（workspace.js 也引本文件）

export const PROJECT_GONE = 'PROJECT_GONE';
const PID_RE = /^proj_[a-z0-9_]{6,80}$/i;

/** 写给 agent 的那句话。要让模型停手，不是让它换个路径重试 */
export function projectGoneMessage(projectId) {
  return `项目已被删除（${PROJECT_GONE}）：${projectId} 已被用户删除，工作区已移入回收站，本次操作没有执行。`
    + '请立即停止对这个项目的一切操作：不要重试，不要换路径写文件，也不要尝试重建目录。';
}

export function projectGoneError(projectId) {
  return Object.assign(new Error(projectGoneMessage(projectId)), { code: PROJECT_GONE, status: 410, projectId });
}

/** MCP 工具直接返回用的形状（工具自己判到项目没了、不走抛错时） */
export function projectGoneResult(projectId) {
  return { content: [{ type: 'text', text: projectGoneMessage(projectId) }], isError: true };
}

export function isProjectGoneError(err) {
  return err?.code === PROJECT_GONE;
}

const rowlessAllowed = () => process.env.NODESIGN_ROWLESS_PROJECTS === 'allow';

/** true = 这个 pid 不能再被写（已删除，或生产模式下根本没有这一行） */
export function isProjectGone(projectId) {
  const state = projectRowState(projectId);
  if (state === 'live') return false;
  if (state === 'deleted') return true;
  return rowlessAllowed() ? hasDeletionRecord(projectId) : true;
}

export function assertProjectLive(projectId) {
  if (isProjectGone(projectId)) throw projectGoneError(projectId);
}

/**
 * 只拿到工作区绝对路径的写入口用（lib/chalk.js 这类）：路径在数据根下就从第一段取 pid 再判。
 * 文件夹项目（桌面版，工作区在用户自己的目录里）取不到 pid，放行 —— 那个目录删除时本来就不动。
 */
export function assertRootLive(absPath) {
  const pid = projectIdOfPath(absPath);
  if (pid) assertProjectLive(pid);
}

export function projectIdOfPath(absPath) {
  if (typeof absPath !== 'string' || !absPath) return null;
  const rel = path.relative(PROJECTS_DATA_ROOT, path.resolve(absPath));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const first = rel.split(path.sep)[0];
  return PID_RE.test(first) ? first : null;
}
