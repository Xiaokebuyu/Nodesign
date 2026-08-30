/**
 * server/projects/session-jsonl.js — SDK 会话转录（jsonl）的文件层（2026-08-30 拆出）。
 *
 * 这里只有"那个文件在哪、在不在、怎么安全地截短"这三件事，跟任何业务无关。
 * 分开住是因为读它的人不止一个：回退要截断它，模型切换要靠它判断"这个会话跑过没有"
 * （没跑过的会话没有历史，跨通路闸不该拦），以后想做分支浏览的也得从它读。
 *
 * 转录的位置由 SDK 定：`<CLAUDE_CONFIG_DIR>/projects/<encodeCwdForSDK(cwd)>/<sid>.jsonl`。
 * 扁平化之后同一个项目所有会话共用一个 cwd，所以它们的 jsonl 都在同一个目录下、按 sid 分文件。
 */

import path from 'path';
import { promises as fs } from 'fs';
import { encodeCwdForSDK } from './workspace.js';
import { platform } from '../runtime/platform.js';

const GLOBAL_CLAUDE_CONFIG_DIR = platform.claudeConfigDir;

/** 这个会话的转录文件路径。 */
export function sessionJsonlPath(sessionRoot, sid) {
  return path.join(GLOBAL_CLAUDE_CONFIG_DIR, 'projects', encodeCwdForSDK(sessionRoot), `${sid}.jsonl`);
}

/** 转录在不在 —— 等价于"这个会话跑过至少一轮"。 */
export async function jsonlExistsForSession(sessionRoot, sid) {
  try {
    await fs.access(sessionJsonlPath(sessionRoot, sid));
    return true;
  } catch {
    return false;
  }
}

/**
 * 对话层回滚（2026-08-08）：把 jsonl 截断到 userMessageId 那条之前（含它与其后全部）。
 * jsonl 是追加式日志，截到 prefix = 它历史上真实存在过的状态，resume 天然自洽；
 * 之后的 file-history-snapshot 属于被撤销的编辑，一并丢弃是正确语义。
 * 原子写（tmp+rename）。找不到该 uuid 返 null（fail-soft：文件回滚仍算成功）。
 */
export async function truncateJsonlAtMessage(sessionRoot, sid, userMessageId) {
  const jsonlPath = sessionJsonlPath(sessionRoot, sid);
  try {
    const raw = await fs.readFile(jsonlPath, 'utf8');
    const lines = raw.split('\n');
    let cut = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i] || !lines[i].includes(userMessageId)) continue;
      try { if (JSON.parse(lines[i]).uuid === userMessageId) { cut = i; break; } } catch { /* 非 JSON 行跳过 */ }
    }
    if (cut < 0) {
      console.warn(`[sessions.rewind] uuid ${userMessageId.slice(0, 8)} 不在 jsonl 里，跳过对话截断`);
      return null;
    }
    const kept = lines.slice(0, cut).join('\n');
    const tmp = `${jsonlPath}.tmp-rewind`;
    await fs.writeFile(tmp, kept ? `${kept}\n` : '');
    await fs.rename(tmp, jsonlPath);
    return lines.filter(Boolean).length - lines.slice(0, cut).filter(Boolean).length;
  } catch (err) {
    console.warn(`[sessions.rewind] jsonl 截断失败（不影响文件回滚）：${err.message}`);
    return null;
  }
}

/**
 * 砍掉转录末尾的那条用户消息（连同它之后的一切）。
 *
 * 专给 fork 用。SDK 的 `forkSession(upToMessageId)` 是**含**那条的（08-30 探针实测：
 * fork 到第二条用户消息，新转录里那条还在），而「从这里分叉」用户点的是**自己那句
 * 说错的话** —— 含着它 fork 出来等于什么都没改。所以 fork 完再补这一刀。
 *
 * 为什么不能拿原来那个 uuid 去截：fork 会 **remap 每条消息的 uuid**（SDK 文档原话
 * "remapping every message UUID"），原 id 在新文件里根本不存在。而 fork 既然截止在
 * 那条消息，它必然就是新转录里最后一条**真**用户消息 —— tool_result 也顶着
 * type='user' 的壳，所以要把那种排掉，认的是带 text block（或纯字符串正文）的那条。
 *
 * @returns {Promise<number|null>} 删掉的行数；没找到用户消息返回 null（fail-soft）
 */
export async function truncateJsonlAtLastUserMessage(sessionRoot, sid) {
  const jsonlPath = sessionJsonlPath(sessionRoot, sid);
  try {
    const raw = await fs.readFile(jsonlPath, 'utf8');
    const lines = raw.split('\n');
    let cut = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]) continue;
      let o;
      try { o = JSON.parse(lines[i]); } catch { continue; }
      if (o.type !== 'user') continue;
      const c = o.message?.content;
      const isRealUserText = typeof c === 'string'
        || (Array.isArray(c) && c.some((b) => b?.type === 'text'));
      if (!isRealUserText) continue;   // tool_result 也是 type='user'
      cut = i;
      break;
    }
    if (cut < 0) {
      console.warn(`[fork] ${sid.slice(0, 8)} 的转录里找不到用户消息，跳过补刀`);
      return null;
    }
    const kept = lines.slice(0, cut).join('\n');
    const tmp = `${jsonlPath}.tmp-fork`;
    await fs.writeFile(tmp, kept ? `${kept}\n` : '');
    await fs.rename(tmp, jsonlPath);
    return lines.filter(Boolean).length - lines.slice(0, cut).filter(Boolean).length;
  } catch (err) {
    console.warn(`[fork] 转录补刀失败：${err.message}`);
    return null;
  }
}
