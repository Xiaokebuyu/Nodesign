/**
 * 状态块点名暂存架（2026-08-30）——「装了闸就真去攻一遍」：造一个架上有货的板，
 * 看点名和三个安置动词真出现；东西被挪走（seat 改写）后不再点名。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-ups-shelf-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { makeUserPromptSubmitHandler } = await import('./user-prompt-submit.js');
const { resetTurnMemory } = await import('./turn-state-memory.js');
const { patchBoard } = await import('../../../projects/board-store.js');
const { ensureProjectWorkspace, getSharedDir } = await import('../../../projects/workspace.js');
const { setViewpoint } = await import('../../../projects/viewpoint-store.js');

describe('状态块：暂存架点名', () => {
  it('⭐ 架上有货 → 点名 + 安置动词；挪走后不再点名', async () => {
    const pid = 'proj_ups_shelf_1';
    await ensureProjectWorkspace(pid);
    setViewpoint(pid, { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1 });
    await patchBoard(pid, {
      objects: {
        'assets/references/ref-1.jpg': { x: 24, y: 24, w: 200, h: 176, seat: 'shelf' },
        '说明.md': { x: 24, y: 224, w: 300, h: 100, seat: 'shelf' },
      },
      shelf: { x: 24, y: 24 },
    });
    const sid = `test-shelf-${Date.now()}`;
    resetTurnMemory(sid);
    const h = makeUserPromptSubmitHandler({ workspaceRoot: getSharedDir(pid), sessionId: sid, projectId: pid });
    const r1 = (await h({ prompt: 'hi' }, 't', {})).hookSpecificOutput.additionalContext;
    expect(r1).toMatch(/2 件在暂存架等你安置/);
    expect(r1).toMatch(/ref-1\.jpg、说明\.md/);
    expect(r1).toMatch(/pin_to_board\{path,slot\}/);

    // agent 把一件安置了（seat 改写 = 离架），另一件用户拖走了
    await patchBoard(pid, { objects: {
      'assets/references/ref-1.jpg': { seat: 'agent' },
      '说明.md': { seat: 'user' },
    } });
    resetTurnMemory(sid);
    const r2 = (await h({ prompt: 'hi' }, 't', {})).hookSpecificOutput.additionalContext;
    expect(r2).not.toMatch(/暂存架/);
    resetTurnMemory(sid);
  });
});
