/**
 * server/projects/rewind-snapshot.js —— 回退前后各留一份（09-17，问题库 iss_mtxwluiz_welc）
 *
 * 病：回退改文件走的是 SDK file checkpoint（rewindFiles），不产生 git 提交；项目 git 只在
 * 每轮收尾提交（session-loop finishTurn → commitWorkspace）。于是**回合进行中回退**时，这一轮
 * 还没提交的改动没有任何副本 —— 用户报的「末尾 36 行消失」就是这个形状。
 *
 * 治法：rewindFiles 之前提交一次（「回退前」），之后再提交一次（「回退后」），都走
 * commitWorkspace，跟每轮收尾同一把 `git:<桌面>` 锁，判脏和提交在锁里一起做；没变化不落空提交，
 * 「回退前」那次这时回当时的 HEAD（回退前的版本就是它）。
 *
 * 仓库道（用户自己的仓库，repo.js）：**不往用户仓库里提交**。
 *   - 桌面 `<folder>/.nodesign` 是 NoDesign 自己的仓库（每轮收尾本来就在那里提交），照常两笔；
 *   - 用户的文件夹用 repo.js 现成的快照（snapshotTree：临时索引 write-tree，不碰他的索引、HEAD、分支），
 *     拿到一棵 tree。文件夹不是 git 仓库时拍不了，响应里写明「没保存」。
 *
 * ⚠️ 保不住的：gitignore 掉的路径（assets/generated/、参考图/、board.json 等）不进提交；
 *    板书是 MCP 工具服务端直写的，本来也不随 rewindFiles 回滚。
 */
import { commitWorkspace, getWorkspaceRoot } from './workspace.js';
import { repoFolderOf, snapshotTree } from './repo.js';
import { appendRewindNote } from './rewind-note.js';

const label = (phase, sessionId, userMessageId) => `${phase} · 会话 ${sessionId} · 消息 ${userMessageId}`;

/**
 * rewindFiles 之前调。失败不拦回退（用户要的是回退；git 坏了每轮收尾也提交不了），
 * 但原因写进 preRewindNote，前端据此提示「没保存」。
 * @returns {Promise<{ preRewindCommit?: string, preRewindTree?: string, preRewindNote?: string }>}
 */
export async function saveBeforeRewind(projectId, sessionId, userMessageId) {
  const out = {};
  const notes = [];
  try {
    const hash = await commitWorkspace(projectId, sessionId, label('回退前', sessionId, userMessageId), { author: 'system', orHead: true });
    if (hash) out.preRewindCommit = hash;
    else notes.push('工作区没有 git 历史');
  } catch (err) {
    notes.push(`工作区提交失败：${err?.message || err}`);
  }
  const folder = repoFolderOf(projectId);
  if (folder) {
    const tree = await snapshotTree(folder).catch(() => null);
    if (tree) out.preRewindTree = tree;
    else notes.push('文件夹不是 git 仓库，文件夹里回退前的内容没有保存');
  }
  if (notes.length) out.preRewindNote = notes.join('；');
  return out;
}

/**
 * rewindFiles（和对话截断）之后调：再提交一次；回退真的发生了才给 agent 记一笔。
 * @param {object} saved  saveBeforeRewind 的返回
 * @param {object} result rewindFiles 的返回（canRewind === false = 什么都没回）
 * @param {string} [noteSessionId] 接着说话的会话（分叉时是新会话），缺省 = 回退的这条
 * @returns {Promise<string|null>} 回退后那笔提交；没变化 / 失败为 null
 */
export async function saveAfterRewind(projectId, sessionId, userMessageId, { saved = {}, result = null, noteSessionId = null } = {}) {
  let post = null;
  try {
    post = await commitWorkspace(projectId, sessionId, label('回退后', sessionId, userMessageId), { author: 'system' });
  } catch (err) {
    console.warn(`[rewind] 回退后提交失败 (sid=${String(sessionId).slice(0, 8)}): ${err?.message || err}`);
  }
  if (result?.canRewind !== false && (saved.preRewindCommit || saved.preRewindTree)) {
    const desk = getWorkspaceRoot(projectId);
    await appendRewindNote(desk, noteSessionId || sessionId, {
      commit: saved.preRewindCommit, tree: saved.preRewindTree, desk, folder: repoFolderOf(projectId),
    }).catch((err) => console.warn(`[rewind] 回退记录没写进去: ${err?.message || err}`));
  }
  return post;
}
