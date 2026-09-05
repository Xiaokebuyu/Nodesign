/**
 * PreToolUse(板工具族) —— 板上动静插话（2026-08-29 建；09-05 纸退役后按层报）。
 *
 * 用户在 agent 干活期间拖动/搬家/擦组，下一轮注入才说太晚 —— agent 这一轮接着
 * 摆就是按旧位置摆。这里在它**下一次摸板**（write/edit/read/batch/
 * organize）前插一句「用户刚动过什么」，按会话恰好一次（markSeen 台账）：说过的
 * 不重复，新动静再说新的。fail-soft —— 注不上不能挡工具。
 */
import { dirtyEvents, describeDirty, lastSeen, markSeen } from '../../../lib/board-dirty.js';

export function makePreToolUseBoardDirtyInjector({ projectId, sessionId }) {
  return async () => {
    try {
      if (!projectId || !sessionId) return {};
      const since = lastSeen(projectId, sessionId);
      const evts = dirtyEvents(projectId, since);
      if (!evts.length) return {};
      markSeen(projectId, sessionId, evts[evts.length - 1].seq);
      const line = describeDirty(evts, { limit: 6 });
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          additionalContext: `⚠ 用户刚在板上动过手：${line}。位置以现状为准（拿不准先 read_board），别把他挪过的东西又搬回去。`,
        },
      };
    } catch { return {}; }
  };
}
