/**
 * 板上动静台账（2026-08-29 纸范式刀 4）。
 * 钉三件事：位置事件的记与读、按会话恰好一次的插话台账、注入器的话术出口。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { noteBoardDirty, dirtyEvents, lastSeen, markSeen, describeDirty, _resetBoardDirty } from './board-dirty.js';
import { makePreToolUseBoardDirtyInjector } from '../engine/agent/hooks/pre-board-dirty.js';

describe('board-dirty 台账', () => {
  beforeEach(() => _resetBoardDirty());

  it('记与读：新动静在 since 之后可见', () => {
    noteBoardDirty('p', [{ kind: 'moved', id: 'notes/板书/a.md' }]);
    const evts = dirtyEvents('p', 0);
    expect(evts.length).toBe(1);
    expect(evts[0]).toMatchObject({ kind: 'moved', id: 'notes/板书/a.md' });
    expect(dirtyEvents('p', evts[0].seq)).toEqual([]);
  });

  it('describeDirty：四种动静各有人话；超限收尾', () => {
    const evts = [
      { at: 1, kind: 'moved', id: 'a' },
      { at: 2, kind: 'removed', id: 'b' },
      { at: 3, kind: 'mv', id: 'c', to: '文件夹/c' },
      { at: 4, kind: 'erased', id: '旧章' },
    ];
    const line = describeDirty(evts);
    expect(line).toContain('挪了 a');
    expect(line).toContain('从板上移走了 b');
    expect(line).toContain('把文件搬到 文件夹/c');
    expect(line).toContain('擦掉了整组 #旧章');
    expect(describeDirty(evts, { limit: 2 })).toContain('还有 2 条更早的');
  });

  it('⭐ PreToolUse 注入器：有动静插一句并 markSeen，说过的不重复，新动静再说', async () => {
    const inject = makePreToolUseBoardDirtyInjector({ projectId: 'p', sessionId: 's1' });
    expect(await inject()).toEqual({});                       // 没动静：闭嘴
    noteBoardDirty('p', [{ kind: 'moved', id: 'x' }]);
    const r = await inject();
    expect(r.hookSpecificOutput.additionalContext).toContain('挪了 x');
    expect(await inject()).toEqual({});                       // 恰好一次
    noteBoardDirty('p', [{ kind: 'moved', id: 'y' }]);
    const r2 = await inject();
    expect(r2.hookSpecificOutput.additionalContext).toContain('挪了 y');
    expect(r2.hookSpecificOutput.additionalContext).not.toContain('挪了 x');
  });

  it('会话隔离：s1 看过不影响 s2', async () => {
    noteBoardDirty('p', [{ kind: 'moved', id: 'x' }]);
    markSeen('p', 's1');
    expect(lastSeen('p', 's2')).toBe(0);
    const inject2 = makePreToolUseBoardDirtyInjector({ projectId: 'p', sessionId: 's2' });
    const r = await inject2();
    expect(r.hookSpecificOutput.additionalContext).toContain('挪了 x');
  });
});

describe('有限负责制（2026-08-30 刀⑤）：动静按纸分拣', () => {
  const sheetOf = (id) => ({ 我纸上的: 'p2', 别张纸的: 'p1' }[id] || null);

  it('⭐ 挪进当前纸的归 inMine，别处的归 elsewhere（纸外算 elsewhere）', async () => {
    const { splitDirtyByCharge } = await import('./board-dirty.js');
    const evts = [
      { kind: 'moved', id: '我纸上的' },
      { kind: 'moved', id: '别张纸的' },
      { kind: 'moved', id: '散地上的' },
    ];
    const r = splitDirtyByCharge(evts, { sheetOf, currentSheetId: 'p2' });
    expect(r.inMine).toEqual(['我纸上的']);
    expect(r.elsewhere.sort()).toEqual(['别张纸的', '散地上的']);
  });

  it('同一件动多次只算一次；erased 不进分拣（东西没了没有归属可言）；mv 按新家判', async () => {
    const { splitDirtyByCharge } = await import('./board-dirty.js');
    const r = splitDirtyByCharge([
      { kind: 'moved', id: '我纸上的' }, { kind: 'moved', id: '我纸上的' },
      { kind: 'erased', id: '旧组' },
      { kind: 'mv', id: '旧名', to: '我纸上的' },
    ], { sheetOf, currentSheetId: 'p2' });
    expect(r.inMine).toEqual(['我纸上的', '旧名']);
    expect(r.elsewhere).toEqual([]);
  });

  it('没有当前纸（还没铺过）→ 全归 elsewhere，不瞎认领', async () => {
    const { splitDirtyByCharge } = await import('./board-dirty.js');
    const r = splitDirtyByCharge([{ kind: 'moved', id: '我纸上的' }], { sheetOf, currentSheetId: null });
    expect(r.inMine).toEqual([]);
    expect(r.elsewhere).toEqual(['我纸上的']);
  });
});
