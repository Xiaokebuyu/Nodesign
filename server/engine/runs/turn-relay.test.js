/**
 * turn-relay：run ↔ 用户消息的配对状态机（2026-08-20 run 记账错位案的钉子）。
 *
 * 被钉住的语义（机制全文见 turn-relay.js claimRunByUuid 上方注释）：
 *   - push 盖 uuid；idle 直设 current；有人在跑或有人排队 → 一律排队
 *   - 回显认领：current / promoted / merged / unknown 四种结果
 *   - finishTurn 只让出 current，不按计数晋升
 *   - FIFO 兜底只在 current 为空时生效
 * 序列直接取自探针 `server/_probe-turn-merge.mjs` 的两次真跑（并轮 / priority later 排队）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AsyncQueue } from '../../lib/async-queue.js';
import { registerQuerySession, unregisterQuerySession, getCurrentTurnRunId } from './active-runs.js';
import {
  pushUserMessage, claimRunByUuid, releaseCurrentTurnRunId, promoteNextPendingRunId,
  isBackgroundTurnOpener,
  getPendingRunCount, getQueueDepth,
} from './turn-relay.js';

const SID = 'test-session-merge';
let queue;
const msg = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, parent_tool_use_id: null });

beforeEach(() => {
  queue = new AsyncQueue();
  registerQuerySession(SID, { abortController: new AbortController(), inputQueue: queue });
});
afterEach(() => { unregisterQuerySession(SID); });

describe('pushUserMessage', () => {
  it('盖 uuid 章；idle 时直设 current，不排队', () => {
    const m = msg();
    expect(pushUserMessage(SID, 'run-1', m)).toBe(true);
    expect(m.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(getCurrentTurnRunId(SID)).toBe('run-1');
    expect(getPendingRunCount(SID)).toBe(0);
  });

  it('调用方已带 uuid 则沿用，不覆盖', () => {
    const m = { ...msg(), uuid: 'caller-uuid' };
    pushUserMessage(SID, 'run-1', m);
    expect(m.uuid).toBe('caller-uuid');
    expect(claimRunByUuid(SID, 'caller-uuid')).toEqual({ runId: 'run-1', outcome: 'current' });
  });

  it('turn 进行中 push → 排队，不抢占 current', () => {
    pushUserMessage(SID, 'run-1', msg());
    pushUserMessage(SID, 'run-2', msg());
    expect(getCurrentTurnRunId(SID)).toBe('run-1');
    expect(getPendingRunCount(SID)).toBe(1);
    expect(getQueueDepth(SID)).toBe(1);   // "已排队 N 条"的 N 就是它
  });

  it('turn 刚结束（current 空）但前面还有人排队 → 新 push 也排队，不插队', () => {
    pushUserMessage(SID, 'run-1', msg());
    pushUserMessage(SID, 'run-2', msg());
    releaseCurrentTurnRunId(SID);            // run-1 的 result 到了
    pushUserMessage(SID, 'run-3', msg());    // run-2 还没被回显
    expect(getCurrentTurnRunId(SID)).toBe(null);
    expect(getPendingRunCount(SID)).toBe(2);
  });
});

describe('claimRunByUuid', () => {
  it('不是我们盖章的消息（CLI 合成 / tool_result）→ null', () => {
    pushUserMessage(SID, 'run-1', msg());
    expect(claimRunByUuid(SID, 'some-cli-generated-uuid')).toBe(null);
    expect(claimRunByUuid(SID, undefined)).toBe(null);
  });

  it('探针序列 A（默认 priority，CLI 并轮）：m2 回显在 turn 进行中 → merged，不动 current', () => {
    const m1 = msg(); const m2 = msg();
    pushUserMessage(SID, 'run-1', m1);
    pushUserMessage(SID, 'run-2', m2);
    // CLI 回显 m1 = turn 开工（它本来就是 current）
    expect(claimRunByUuid(SID, m1.uuid)).toEqual({ runId: 'run-1', outcome: 'current' });
    // tool_result 回来、下一次模型调用前 CLI 回显 m2 —— 并进了 run-1 这轮
    expect(claimRunByUuid(SID, m2.uuid)).toEqual({ runId: 'run-2', outcome: 'merged', intoRunId: 'run-1' });
    expect(getCurrentTurnRunId(SID)).toBe('run-1');
    expect(getPendingRunCount(SID)).toBe(0);
    // 唯一的 result 关的是 run-1 —— 没有错位
    releaseCurrentTurnRunId(SID);
    expect(getCurrentTurnRunId(SID)).toBe(null);
    // 同一 uuid 回显两次不会再认领（章已撕）
    expect(claimRunByUuid(SID, m2.uuid)).toBe(null);
  });

  it('探针序列 B（priority later，CLI 排到下一轮）：m2 回显在 result 之后 → promoted', () => {
    const m1 = msg(); const m2 = msg();
    pushUserMessage(SID, 'run-1', m1);
    pushUserMessage(SID, 'run-2', m2);
    expect(claimRunByUuid(SID, m1.uuid).outcome).toBe('current');
    releaseCurrentTurnRunId(SID);            // RESULT #1
    expect(claimRunByUuid(SID, m2.uuid)).toEqual({ runId: 'run-2', outcome: 'promoted' });
    expect(getCurrentTurnRunId(SID)).toBe('run-2');
    expect(getPendingRunCount(SID)).toBe(0);
  });

  it('三条连发：m2 并轮、m3 下一轮 —— 每条 run 各归各位', () => {
    const m1 = msg(); const m2 = msg(); const m3 = msg();
    pushUserMessage(SID, 'run-1', m1);
    pushUserMessage(SID, 'run-2', m2);
    pushUserMessage(SID, 'run-3', m3);
    claimRunByUuid(SID, m1.uuid);
    expect(claimRunByUuid(SID, m2.uuid).outcome).toBe('merged');
    releaseCurrentTurnRunId(SID);
    expect(claimRunByUuid(SID, m3.uuid)).toEqual({ runId: 'run-3', outcome: 'promoted' });
    releaseCurrentTurnRunId(SID);
    expect(getPendingRunCount(SID)).toBe(0);
  });

  it('回显的是盖过章、但已被 FIFO 兜底晋升过的 run → current（幂等，不重复晋升）', () => {
    const m1 = msg(); const m2 = msg();
    pushUserMessage(SID, 'run-1', m1);
    pushUserMessage(SID, 'run-2', m2);
    releaseCurrentTurnRunId(SID);
    expect(promoteNextPendingRunId(SID)).toBe('run-2');   // 兜底先晋升
    expect(claimRunByUuid(SID, m2.uuid)).toEqual({ runId: 'run-2', outcome: 'current' });
  });
});

describe('promoteNextPendingRunId（FIFO 兜底）', () => {
  it('current 非空时不动（不抢占正在跑的 turn）', () => {
    pushUserMessage(SID, 'run-1', msg());
    pushUserMessage(SID, 'run-2', msg());
    expect(promoteNextPendingRunId(SID)).toBe('run-1');
    expect(getPendingRunCount(SID)).toBe(1);
  });
  it('current 空时按队头晋升', () => {
    pushUserMessage(SID, 'run-1', msg());
    pushUserMessage(SID, 'run-2', msg());
    releaseCurrentTurnRunId(SID);
    expect(promoteNextPendingRunId(SID)).toBe('run-2');
    expect(getPendingRunCount(SID)).toBe(0);
  });
});

describe('unregister', () => {
  it('排队的章一并清掉（重注册同 sid 不会认领到旧消息）', () => {
    const m2 = msg();
    pushUserMessage(SID, 'run-1', msg());
    pushUserMessage(SID, 'run-2', m2);
    unregisterQuerySession(SID);
    registerQuerySession(SID, { abortController: new AbortController(), inputQueue: new AsyncQueue() });
    expect(claimRunByUuid(SID, m2.uuid)).toBe(null);
    expect(getPendingRunCount(SID)).toBe(0);
  });
});

describe('isBackgroundTurnOpener —— 子代理说话不许铸主回合', () => {
  it('主循环的 assistant / user / stream_event 照常开回合', () => {
    for (const type of ['assistant', 'user', 'stream_event']) {
      expect(isBackgroundTurnOpener({ type })).toBe(true);
      expect(isBackgroundTurnOpener({ type, parent_tool_use_id: null })).toBe(true);
    }
  });

  it('⭐ 带 parent_tool_use_id 的一律不算 —— 那是子代理在说话', () => {
    for (const type of ['assistant', 'user', 'stream_event']) {
      expect(isBackgroundTurnOpener({ type, parent_tool_use_id: 'toolu_016znNw6tL1je1kXh2wBBWci' })).toBe(false);
    }
  });

  it('别的类型本来就不开回合', () => {
    expect(isBackgroundTurnOpener({ type: 'result' })).toBe(false);
    expect(isBackgroundTurnOpener({ type: 'system' })).toBe(false);
    expect(isBackgroundTurnOpener(null)).toBe(false);
  });
});
