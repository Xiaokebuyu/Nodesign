/**
 * engine/runs/user-messages.js —— 用户在本项目发给 agent 的原话（2026-09-17，数据丢失调查方案 1b）
 *
 * 数据源是 runs.brief。api/turn.js 在 202 之前 `createRun({ brief: displayText })`，把
 * composeUserMessage 拼出的 displayText 全文写进去；之后回退（sessions-rewind.js）只截 SDK 的
 * jsonl，中断和失败只改 status / error，都不动这一列。所以被「回到此处」从对话里删掉的消息、
 * 中断和失败回合的消息，原文都还在这里。agent 以前没有读它的入口，用户要「整合我说过的话」时
 * 只能凭上下文里残存的那部分（问题库 iss_mtxylgs4_xmmz、iss_mtvaq77w_xfa8）。
 *
 * 只收发给主 agent 的消息：skill_id 为 stage（演出进程的一句台词，brief 截到 200 字，全文在
 * 故事文件夹的场景记录里）与 chatai（演出端点，截到 120 字）的行不是对 agent 说的话，排除。
 *
 * ⛔ 项目限定是硬条件：每条 SQL 都带 `project_id = ?`，projectId 只从调用方来（工具构造时绑定的
 * 依赖），模型传不进来。sessionId / runId 都只在本项目的行里再筛，别的项目的会话 id 查出来是空。
 */

import db from './store.js';
// runs 的归属列（project_id / user_id / session_id）是 projects/store.js 模块加载时幂等 ALTER 补的，
// 只 import runs/store.js 的进程里这几列可能还不存在。这里显式带上，查询不依赖别人先 import 过它。
import '../../projects/store.js';

/** 不是用户对主 agent 说的话的 run（演出进程 / 演出端点），见文件头 */
const NOT_AGENT_TURN = ['stage', 'chatai'];
const AGENT_TURN_SQL = `skill_id NOT IN (${NOT_AGENT_TURN.map(() => '?').join(', ')})`;

/** 带关键词时先按 LIKE 粗筛，再在剥过注入块的正文上精筛；粗筛最多取这么多条（按新到旧） */
const QUERY_SCAN = 500;

// ── displayText 里不是用户写的部分（形状照 api/turn-compose.js；契约测试拿真 composeUserMessage 对拍）──

/** 开头的系统注入块：DirectEdit 待处理摘要；08-21 之前还有一块素材摘要，同样是 <system> 包着 */
const LEAD_SYSTEM_BLOCK = /^<system>[\s\S]*?<\/system>(?:\n\n|$)/;
/** 只发附件、没写字时 composer 代填的一句 */
const ONLY_ATTACHMENTS_PLACEHOLDER = '[用户只发了附件，没有附带文字。先看附件再问他想拿它做什么]';
/**
 * 用户文字之后的附件说明块，从尾部逐块剥。count：这一块算几件附件（内联图的「已直接附上」那行
 * 与 [image] 占位说的是同一批图，不重复计）。可用素材块里的「选中元素 / 评论」也按件计。
 */
const TAIL_BLOCKS = [
  { re: /\n\nOffice 文档（\*\*用 mcp__nodesign__read_document 读[^\n]*：\n- [\s\S]*$/, count: (m) => lineItems(m) },
  { re: /\n\n可用素材（用 Read 工具读取[^\n]*：\n- [\s\S]*$/, count: (m) => lineItems(m) },
  // 08-21 之前 comment 附件会多挂一行评论提示（plan 时代，已删），存量 brief 里还有
  { re: /\n\n\[评论提示 — [^\n]*\]$/, count: () => 0 },
  { re: /\n\n\[已直接附上 \d+ 张参考图：[^\n]*\]$/, count: () => 0 },
  { re: /\n\n\[image\]$/, count: () => 1 },
];
const lineItems = (block) => (block.match(/\n- /g) || []).length;

/**
 * 把一条 brief 还原成用户写的字。
 * @returns {{ text: string, attachments: number }} text 可能为空（只发了附件）
 */
export function cleanBrief(brief) {
  let text = String(brief ?? '');
  while (LEAD_SYSTEM_BLOCK.test(text)) text = text.replace(LEAD_SYSTEM_BLOCK, '');
  let attachments = 0;
  for (let changed = true; changed;) {
    changed = false;
    for (const { re, count } of TAIL_BLOCKS) {
      const m = re.exec(text);
      if (!m) continue;
      attachments += count(m[0]);
      text = text.slice(0, m.index);
      changed = true;
    }
  }
  if (text === ONLY_ATTACHMENTS_PLACEHOLDER) text = '';
  return { text, attachments };
}

/**
 * 回合结局（runs.status + error）→ 给 agent 看的一个词。
 * session-loop 的 finishTurn 对中断回合也走 markRunFailed（error 以 `cancelled:` 开头），
 * status 列本身分不出中断和失败，要看 error。几个固定文案的出处：
 *   'server restarted while run in flight'       runs/store.js sweepOrphanRuns
 *   'session ended before queued turn started'   runs/active-runs.js 会话关闭时清排队
 */
export function turnOutcome({ status, error }) {
  if (status === 'succeeded') return '成功';
  if (status === 'pending' || status === 'running') return '进行中';
  if (status === 'cancelled') return '中断';
  const e = String(error || '');
  if (e.startsWith('cancelled:')) return '中断';
  if (e === 'server restarted while run in flight') return '中断（服务重启）';
  if (e === 'session ended before queued turn started') return '失败（排队时会话已结束，没有执行）';
  const reason = e.replace(/\s+/g, ' ').trim().slice(0, 60);
  return reason ? `失败：${reason}` : '失败';
}

function toItem(row) {
  const { text, attachments } = cleanBrief(row.brief);
  return {
    runId: row.id,
    sessionId: row.session_id || null,
    createdAt: row.created_at,
    outcome: turnOutcome(row),
    text,
    attachments,
  };
}

const escapeLike = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * 本项目里最近的用户消息。
 * @param {object} o
 * @param {string} o.projectId          必填；只从调用方来
 * @param {string} [o.sessionId]        只看这个会话（仍限本项目）
 * @param {string} [o.sinceSql]         'YYYY-MM-DD HH:MM:SS'（UTC，与 created_at 同格式）
 * @param {string} [o.query]            正文包含（不分大小写）
 * @param {number} o.limit
 * @returns {{ items: object[], hasMore: boolean }} items 旧→新；hasMore = 比这批更早的还有
 */
export function listUserMessages({ projectId, sessionId = null, sinceSql = null, query = null, limit }) {
  if (!projectId) throw new Error('listUserMessages: projectId 必填');
  const where = ['project_id = ?', AGENT_TURN_SQL];
  const args = [projectId, ...NOT_AGENT_TURN];
  if (sessionId) { where.push('session_id = ?'); args.push(sessionId); }
  if (sinceSql) { where.push('created_at >= ?'); args.push(sinceSql); }
  if (query) { where.push("brief LIKE ? ESCAPE '\\'"); args.push(`%${escapeLike(query)}%`); }
  const rows = db.prepare(
    `SELECT id, session_id, status, error, brief, created_at FROM runs
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(...args, query ? QUERY_SCAN : limit + 1);
  let items = rows.map(toItem);
  // 粗筛命中的可能只是注入块里的字（附件文件名、系统摘要），按剥过的正文再筛一遍
  if (query) {
    const q = query.toLowerCase();
    items = items.filter((it) => it.text.toLowerCase().includes(q));
  }
  return { items: items.slice(0, limit).reverse(), hasMore: items.length > limit };
}

/** 本项目里的一条用户消息；runId 不属于本项目（或是演出行）时返回 null */
export function getUserMessage({ projectId, runId }) {
  if (!projectId) throw new Error('getUserMessage: projectId 必填');
  const row = db.prepare(
    `SELECT id, session_id, status, error, brief, created_at FROM runs
      WHERE id = ? AND project_id = ? AND ${AGENT_TURN_SQL}`,
  ).get(runId, projectId, ...NOT_AGENT_TURN);
  return row ? toItem(row) : null;
}
