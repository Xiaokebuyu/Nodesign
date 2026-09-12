/**
 * server/projects/session-title.js — 会话标题（SDK helper 写的摘要）什么时候能读到（2026-09-12）
 *
 * 标题不是我们生成的：SDK 用 haiku helper 在回合结束后**异步**把 summary 写进转录 jsonl，
 * 我们只负责读（getSessionInfo）。以前的两个读者都只读一次：
 *   - 前端在 run.done 后 refetch 会话列表 → 多半读到上一轮的标题，要刷新才看得到；
 *   - auto-name.js 在 finishTurn 里读一次 → 读不到就等下一轮，首轮项目名一直是垫的。
 * 两个症状同一个竞态。这里做成一件事：回合结束后按退避重读几次，标题一变就
 * 推 `session.titled`，同一份结果再喂给项目正名。⚠️ 别改成轮询会话列表——那条路
 * 每次要对全部 sid 各调一次 getSessionInfo。
 */

import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { autoNameProjectFromSession } from './auto-name.js';
import { getSessionWorkspace } from './workspace.js';
import { withConfigDir } from '../lib/sdk-session.js';
import { platform } from '../runtime/platform.js';

/** 回合结束后第几毫秒再读一次。haiku 那一发通常 1～5 秒落盘；最后一档兜慢机器 */
export const TITLE_RETRY_DELAYS_MS = [600, 2500, 6000, 14000];

/**
 * 读一次当前标题（customTitle 优先，其次 summary）。读不到返回 null，不抛。
 * ⚠️ 转录按 **cwd** 编码定位，所以根目录问 getSessionWorkspace（跟 api/sessions.js 同源）。
 * auto-name.js 之前拼的是 `<项目>/sessions/<sid>`（08-08 扁平化前的老家），一直读不到。
 *
 * ⚠️ SDK 在 helper 还没写摘要时拿**第一句话**当 summary 兜底（实测）。聊天卡顶栏显示它没问题，
 * 但项目正名不能吃这个兜底值（吃了就把 auto_named 清掉，helper 的真标题永远轮不到）。
 * 所以一并返回 fromHelper：customTitle（用户改的）或 summary ≠ firstPrompt 才算真标题。
 *
 * @returns {Promise<{title: string, fromHelper: boolean}|null>}
 */
export async function readSessionTitle(projectId, sessionId) {
  if (!projectId || !sessionId) return null;
  let sessionRoot;
  try { sessionRoot = getSessionWorkspace(projectId, sessionId); } catch { return null; }
  try {
    const info = await withConfigDir(platform.claudeConfigDir, () =>
      getSessionInfo(sessionId, { dir: sessionRoot }),
    );
    const customTitle = String(info?.customTitle || '').trim();
    const summary = String(info?.summary || '').trim();
    const first = String(info?.firstPrompt || '').trim();
    const title = customTitle || summary;
    if (!title) return null;
    const fromHelper = !!customTitle || (summary !== first && !first.startsWith(summary.replace(/[….]+$/, '')));
    return { title, fromHelper };
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 回合结束后盯着标题：每次读到跟上次不一样的就回调 onTitle(title, { fromHelper })。
 * 返回最后一次读到的标题（可能是 null）。不抛。
 *
 * @param {object} opts
 * @param {(title: string, meta: {fromHelper: boolean}) => void} opts.onTitle   每个新标题一次
 * @param {number[]} [opts.delays]                 测试用
 * @param {() => boolean} [opts.isAlive]           会话没了就停（进程已退出没必要再读）
 */
export async function watchSessionTitle(projectId, sessionId, { onTitle, delays = TITLE_RETRY_DELAYS_MS, isAlive = () => true } = {}) {
  let last = null;
  for (const ms of delays) {
    await sleep(ms);
    if (!isAlive()) break;
    const got = await readSessionTitle(projectId, sessionId);
    if (got && got.title !== last) {
      last = got.title;
      try { onTitle?.(got.title, { fromHelper: got.fromHelper }); } catch { /* 回调里的错不打断后面的读 */ }
    }
  }
  return last;
}

/**
 * 回合成功结束时调（session-loop.finishTurn）：fire-and-forget，失败不影响 turn。
 *   - 每读到新标题推 `session.titled`（聊天卡顶栏即时换，不用刷新）；
 *   - helper 写的真标题再喂给项目正名（首页大输入框建的项目名是垫的，只正一次，用户改过就不动）。
 *     第一句话兜底不算：顶栏可以先显示它，项目名要等真标题。
 *   - `project.renamed` 显式清掉 sessionId：首页 / 别的会话的订阅者也要收到（ws 按 sid 过滤）。
 */
export function settleSessionTitle(projectId, sessionId, emit) {
  return watchSessionTitle(projectId, sessionId, {
    onTitle: (title, { fromHelper }) => {
      emit({ type: 'session.titled', sessionId, title });
      if (!fromHelper) return;
      autoNameProjectFromSession(projectId, sessionId, title)
        .then((name) => { if (name) emit({ type: 'project.renamed', projectId, name, sessionId: null }); })
        .catch((err) => console.warn('[auto-name]', err.message));
    },
  }).catch((err) => console.warn('[session-title]', err.message));
}
