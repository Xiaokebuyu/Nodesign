/**
 * server/projects/rewind-note.js —— 「上次回退前的版本在哪」给 agent 的一次性交代（09-17，问题库 iss_mtxwluiz_welc）
 *
 * 病：回退（SDK rewindFiles）把文件恢复到某条消息之前，被撤掉的内容只剩 git 历史里有，
 * 而 agent 不知道有这么一份 —— 用户下一句说「刚才那 36 行找回来」，它只能说找不到。
 * 回退路由在回退前后各落一笔提交（rewind-snapshot.js），这里记下「回退前」那一笔，
 * 下一轮 UserPromptSubmit 状态注入时带一句、然后删掉（只出现一次）。
 *
 * 存在 `<桌面>/.nd/<sid>/rewind-note.json`：`.nd/` 在 gitignore 里，写它不会弄脏工作树 ——
 * 回退后那笔提交是先提交、后写这份记录，写在工作树里的话提交完就又脏了（问题库「每回合
 * 自动写一笔要先想清楚跟版本控制的先后」那一条）。
 *
 * 为什么按会话存、不按项目存：产物是项目级的，但要知道这件事的是**接着说话的那条会话**。
 * 原地回退 = 同一条；分叉带产物回退 = 新开的那条（前端把新 sid 作 noteSessionId 传过来）。
 * 按项目存会被同项目别的会话先消费掉。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const REWIND_NOTE_FILE = 'rewind-note.json';
/** 连着回退几次都留着：第一次回退前的那份才是「最满」的版本，不能被第二次覆盖掉 */
const KEEP = 5;
const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notePath(deskRoot, sessionId) {
  if (!deskRoot || !SID_RE.test(String(sessionId || ''))) return null;
  return path.join(deskRoot, '.nd', sessionId, REWIND_NOTE_FILE);
}

async function readEntries(file) {
  try {
    const j = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(j) ? j.filter((e) => e && typeof e === 'object') : [];
  } catch { return []; }
}

/**
 * 记一笔。entry：{ at, commit?, tree?, desk?, folder? }（commit = 桌面仓库里的提交；tree = 仓库道用户仓库里的快照树）
 * 两样都没有就不记 —— 没有能指给它看的东西，说了反而让它去找一份不存在的版本。
 */
export async function appendRewindNote(deskRoot, sessionId, entry) {
  const file = notePath(deskRoot, sessionId);
  if (!file || !entry || (!entry.commit && !entry.tree)) return false;
  const entries = await readEntries(file);
  entries.push({ at: entry.at || new Date().toISOString(), commit: entry.commit || null, tree: entry.tree || null, desk: entry.desk || null, folder: entry.folder || null });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(entries.slice(-KEEP), null, 2) + '\n', 'utf8');
  return true;
}

/** 取出并删掉（注入只出现一次）。没有就是空数组。 */
export async function takeRewindNote(deskRoot, sessionId) {
  const file = notePath(deskRoot, sessionId);
  if (!file) return [];
  const entries = await readEntries(file);
  // 先删再交：删不掉（权限之类）宁可这一轮不说，也不要每轮都说一遍
  try { await fs.rm(file, { force: true }); } catch { return []; }
  return entries;
}

function describe(e) {
  const when = typeof e.at === 'string' ? e.at.slice(0, 16).replace('T', ' ') + ' UTC' : '时间不详';
  const bits = [];
  if (e.commit) {
    // 仓库道：桌面仓库不是 cwd，git 要 -C 过去；托管项目的 cwd 就是那个仓库
    const where = e.folder && e.desk ? `git -C ${e.desk} ` : 'git ';
    bits.push(`${e.folder ? '桌面' : '产物'}在回退前的版本是提交 ${e.commit}（\`${where}show ${e.commit}:<路径>\`、\`${where}diff ${e.commit} -- <路径>\`）`);
  }
  if (e.tree) {
    bits.push(`你的仓库在回退前的工作树快照是 tree ${e.tree}（不是提交、不在任何分支上；\`git show ${e.tree}:<路径>\`、\`git diff ${e.tree} -- <路径>\`）`);
  }
  return `- ${when} 那次回退：${bits.join('；')}`;
}

/** 渲染成注入文本；没有记录回 null。 */
export function renderRewindNote(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && (e.commit || e.tree));
  if (!list.length) return null;
  return `[回退记录]\n用户回退过产物，被撤掉的内容还在 git 里：\n${list.map(describe).join('\n')}\n`
    + '用户要找回回退掉的内容时，用上面的 git show / git diff 只读地取出内容，再用写文件工具写回；不要 git checkout / reset / commit（历史由服务端管理）。';
}
