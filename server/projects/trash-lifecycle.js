/**
 * server/projects/trash-lifecycle.js — 回收站里项目的恢复、彻底删除、到期清理（09-17，问题库 iss_mtjex6wv_5xhn）
 *
 * 删除本身（关会话、等工具停、挪目录）在 api/project-delete.js：那一步要碰引擎（会话、浏览器、演出进程），
 * 这里只碰库和磁盘，所以到期清理的计时器不用把引擎整个拖进来。
 *
 * 同一个项目的删除 / 恢复 / 彻底删除走同一把锁（withProjectLock）：用户点「撤销」时删除可能还在等会话退出，
 * 恢复要排在删除之后，否则会把一个还没挪走的目录「挪回来」。
 *
 * 保留期满的清理：服务端启动后跑一次、之后每 6 小时一次；每轮最多清 20 个、逐个清、中间停 200ms，
 * 出错只记日志（下一轮再试）。库里没有对应删除记录的回收目录（恢复时挪开的迟到目录等）过了保留期同样清掉。
 */
import { mutex } from 'async-mutex-lite';
import {
  getProject, getProjectIncludingDeleted, clearProjectDeleted, deleteProject, listExpiredDeletedProjects,
} from './store.js';
import {
  restoreWorkspaceFromTrash, purgeWorkspace, trashRetentionDays, listTrashEntries, parseTrashEntryName,
  trashRoot, measureDir, trashPathOf,
} from './project-trash.js';
import { recordDeletionEvent } from './deletion-log.js';
import { removeEntriesForProject } from '../lib/showcase-store.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const DAY_MS = 86_400_000;

export function withProjectLock(projectId, fn) {
  return mutex(`project-life:${projectId}`, fn);
}

function notInTrash(projectId) {
  return Object.assign(new Error(`回收站里没有这个项目：${projectId}`), { code: 'NOT_IN_TRASH', status: 404 });
}

/**
 * 从回收站恢复：挪回工作区、清删除标记。
 * @param {object} [opts.actor] 操作者（req.user）；审计用
 * @param {string} [opts.reason] user | folder-reopen
 * @returns {Promise<object>} 恢复后的项目（getProject 形状）
 */
export function restoreDeletedProject(projectId, { actor = null, reason = 'user' } = {}) {
  return withProjectLock(projectId, async () => {
    const started = Date.now();
    const row = getProjectIncludingDeleted(projectId);
    if (!row?.deletedAt) throw notInTrash(projectId);
    try {
      const r = await restoreWorkspaceFromTrash(projectId, row.trashDir);
      clearProjectDeleted(projectId);
      recordDeletionEvent({
        action: 'restore', reason, project: row, actor, result: 'ok', durationMs: Date.now() - started,
        detail: [row.trashDir ? `from ${row.trashDir}` : '删除时没有工作区目录，只清了占位', r.stray ? `原路径上的迟到目录已挪进回收站 ${r.stray}` : null].filter(Boolean).join('；'),
      });
      return getProject(projectId);
    } catch (err) {
      recordDeletionEvent({ action: 'restore', reason, project: row, actor, result: 'error', detail: `${err.code || ''} ${err.message}`, durationMs: Date.now() - started });
      throw err;
    }
  });
}

/**
 * 彻底删除：回收目录、占位文件、橱窗卡片、项目行。runs 不删（计量留账，09-17 起）；
 * 已发布的站点与市场条目不动（跟 09-17 之前的删除一致，见 api/project-delete.js 头注）。
 * @param {string} [opts.reason] user | expired
 */
export function purgeDeletedProject(projectId, { actor = null, reason = 'user' } = {}) {
  return withProjectLock(projectId, async () => {
    const started = Date.now();
    const row = getProjectIncludingDeleted(projectId);
    if (!row?.deletedAt) throw notInTrash(projectId);
    let size = null;
    try {
      size = row.trashDir ? await measureDir(trashPathOf(row.trashDir)) : null;
      const r = await purgeWorkspace(projectId, row.trashDir);
      // 橱窗卡片指着这个项目的产物，作品没了卡片留着只会点出 404（保留期内卡片留着，恢复后还能用）
      removeEntriesForProject(projectId);
      deleteProject(projectId);
      recordDeletionEvent({
        action: 'purge', reason, project: row, actor, result: 'ok', durationMs: Date.now() - started,
        bytes: size?.bytes ?? null, files: size?.files ?? null,
        detail: `删除了 ${r.removed} 处目录${size?.truncated ? '；大小只统计了前 5 万个条目' : ''}`,
      });
      return { purged: true };
    } catch (err) {
      recordDeletionEvent({
        action: 'purge', reason, project: row, actor, result: 'error', durationMs: Date.now() - started,
        bytes: size?.bytes ?? null, files: size?.files ?? null, detail: `${err.code || ''} ${err.message}`,
      });
      throw err;
    }
  });
}

let sweeping = false;
const pause = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/**
 * 清掉保留期满的。单轮上限 limit 个项目 + limit 个孤儿目录。
 * @returns {Promise<{ purged: string[], failed: string[], orphans: string[], skipped?: boolean }>}
 */
export async function sweepExpiredTrash({ now = Date.now(), days = trashRetentionDays(), limit = 20, pauseMs = 200 } = {}) {
  if (sweeping) return { purged: [], failed: [], orphans: [], skipped: true };
  sweeping = true;
  const out = { purged: [], failed: [], orphans: [] };
  try {
    const cutoffMs = now - days * DAY_MS;
    for (const pid of listExpiredDeletedProjects(new Date(cutoffMs).toISOString(), limit)) {
      try {
        await purgeDeletedProject(pid, { reason: 'expired' });
        out.purged.push(pid);
      } catch (err) {
        out.failed.push(pid);
        console.warn(`[trash] 到期清理 ${pid} 失败（下一轮再试）：${err.message}`);
      }
      if (pauseMs) await pause(pauseMs);
    }
    for (const name of await listTrashEntries()) {
      if (out.orphans.length >= limit) break;
      const parsed = parseTrashEntryName(name);
      if (!parsed || !(Date.parse(parsed.at) < cutoffMs)) continue;
      const row = getProjectIncludingDeleted(parsed.projectId);
      // 项目还在回收站里的，它名下的目录一律归上面那条路管（到期了但清失败 / 超出本轮上限的也是），这里不碰。
      // 这里只清：行已不在（彻底删除后残留），或项目已恢复（恢复时挪开的迟到目录）
      if (row?.deletedAt) continue;
      try {
        await fs.rm(path.join(trashRoot(), name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        out.orphans.push(name);
        recordDeletionEvent({ action: 'purge', reason: 'expired-orphan', projectId: parsed.projectId, project: row ? { ...row, id: parsed.projectId } : null, result: 'ok', detail: `回收站里无主的目录 ${name}` });
      } catch (err) {
        console.warn(`[trash] 清理无主回收目录 ${name} 失败：${err.message}`);
      }
      if (pauseMs) await pause(pauseMs);
    }
  } catch (err) {
    console.warn(`[trash] 到期清理中断：${err.message}`);
  } finally {
    sweeping = false;
  }
  return out;
}

/**
 * 启动时（延迟 initialDelayMs，别跟启动抢盘）跑一次，之后每 intervalMs 一次。计时器 unref，不拖住退出。
 * @returns {() => void} 停掉
 */
export function startTrashSweeper({ initialDelayMs = 60_000, intervalMs = 6 * 3600_000 } = {}) {
  const run = () => sweepExpiredTrash().then((r) => {
    if (r.purged.length || r.failed.length || r.orphans.length) {
      console.log(`[trash] 到期清理：删除 ${r.purged.length} 个项目，失败 ${r.failed.length}，无主目录 ${r.orphans.length}（保留期 ${trashRetentionDays()} 天）`);
    }
  }).catch((err) => console.warn(`[trash] 到期清理出错：${err.message}`));
  const first = setTimeout(run, initialDelayMs);
  first.unref?.();
  const every = setInterval(run, intervalMs);
  every.unref?.();
  return () => { clearTimeout(first); clearInterval(every); };
}
