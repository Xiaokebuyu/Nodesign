/**
 * 台词侧挂集成（2026-08-28 用户拍板）：角色 reply_to 旁白时——
 *   桌面横屏（视点 w>h）→ 挂到旁白两侧的空位（主列留给 GM 的章节链）
 *   竖屏/没有视点     → 保持正下方（手机竖排 = 环境→台词往下摞）
 *   （08-29：模式概念退役，侧挂对所有角色一律成立）
 * 走真 handler + actor 盖章 + 真视点存储。
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-roleside-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { readBoard } = await import('../../../projects/board-store.js');
const { ensureProjectWorkspace, getWorkspaceRoot } = await import('../../../projects/workspace.js');
const { makeWriteOnBoardTool } = await import('./write-on-board.js');
const { makePreToolUseActorStamp } = await import('../../agent/hooks/pre-defaults.js');
const { _resetActorTrail } = await import('../../agent/actor-trail.js');
const { setViewpoint, _resetViewpoints } = await import('../../../projects/viewpoint-store.js');

const stamp = makePreToolUseActorStamp();
let n = 0;
let pidN = 0;
let pid; let ws;

/** 每用例独立项目：落位断言对板上已有障碍敏感，共用板会互相污染 */
beforeEach(async () => {
  pid = `proj_roleside_t${pidN += 1}`;
  await ensureProjectWorkspace(pid);
  ws = getWorkspaceRoot(pid);
  _resetViewpoints();
});
beforeAll(() => {});

const writeAs = async (agentType, args) => {
  _resetActorTrail();
  const toolUseId = `toolu_rs_${n += 1}`;
  if (agentType) await stamp({ agent_id: 'a1', agent_type: agentType }, toolUseId);
  const before = new Set(Object.keys((await readBoard(pid)).objects));
  const t = makeWriteOnBoardTool({ projectId: pid, sharedRoot: ws, sessionId: 's1', ctx: { emit() {} } });
  const r = await t.handler(args, { _meta: { 'claudecode/toolUseId': toolUseId } });
  expect(r.isError, r.content?.[0]?.text).toBeUndefined();
  const board = await readBoard(pid);
  const found = Object.entries(board.objects)
    .find(([id, e]) => id.startsWith('notes/板书/') && (e.by || 'agent') === (agentType || 'agent') && !before.has(id));
  return { board, id: found?.[0], entry: found?.[1] };
};

const gmRect = async () => {
  const gm = await writeAs(null, { text: '# 第一章\n\n走廊里正好有人。她端着垃圾袋迎面过来，脚步顿了一下。' });
  const e = gm.entry;
  return { id: gm.id, x: e.x, y: e.y, w: e.w, h: e.h };
};
const landscape = (cx, cy) => setViewpoint(pid, { camera: { x: cx, y: cy, w: 1600, h: 900 }, zoom: 1, layer: '' });
const portrait = (cx, cy) => setViewpoint(pid, { camera: { x: cx, y: cy, w: 420, h: 900 }, zoom: 1, layer: '' });

describe('台词侧挂', () => {
  it('横屏：角色回旁白挂到右侧空位，不压主列', async () => {
    const gm = await gmRect();
    landscape(gm.x - 200, gm.y - 100);
    const role = await writeAs('rp-jiangli', { text: '「好巧哦。」我晃了晃袋子。', reply_to: gm.id });
    expect(role.entry.x).toBeGreaterThanOrEqual(gm.x + gm.w);   // 在旁白右边
    expect(Math.abs(role.entry.y - gm.y)).toBeLessThan(gm.h);   // 同一拍的高度带
  });

  it('横屏但右侧被占：挂到左侧', async () => {
    const gm = await gmRect();
    // 右侧贴身放一块障碍（agent 写的状态卡）
    await writeAs(null, { text: '### 状态占位', at: { x: gm.x + gm.w + 12, y: gm.y }, width: 18 });
    landscape(gm.x - 200, gm.y - 100);
    const role = await writeAs('rp-jiangli', { text: '台词一句。', reply_to: gm.id });
    expect(role.entry.x + role.entry.w).toBeLessThanOrEqual(gm.x + 4);   // 在旁白左边
  });

  it('竖屏：保持正下方（手机竖排读序）', async () => {
    const gm = await gmRect();
    portrait(gm.x, gm.y);
    const role = await writeAs('rp-jiangli', { text: '台词一句。', reply_to: gm.id });
    expect(role.entry.y).toBeGreaterThanOrEqual(gm.y + gm.h);
    expect(Math.abs(role.entry.x - gm.x)).toBeLessThan(24);   // 同列
  });

  it('没有视点：保持正下方（默认按不认识的设备算）', async () => {
    const gm = await gmRect();
    const role = await writeAs('rp-jiangli', { text: '台词一句。', reply_to: gm.id });
    expect(role.entry.y).toBeGreaterThanOrEqual(gm.y + gm.h);
  });

  it('同一拍的第二个角色也侧挂 —— 挤成一排就是「这一拍」的样子', async () => {
    const gm = await gmRect();
    landscape(gm.x - 200, gm.y - 100);
    const a = await writeAs('rp-jiangli', { text: '台词一句。', reply_to: gm.id });
    const b = await writeAs('rp-bu', { text: '另一个人接了一句。', reply_to: gm.id });
    for (const r of [a, b]) {
      expect(r.entry.y, '侧挂：不该落到旁白正下方').toBeLessThan(gm.y + gm.h);
    }
    expect(b.entry.x).not.toBe(a.entry.x);   // 两个人不重叠
  });

  it('主控自己 reply_to 自己照旧下行（侧挂只归角色的台词）', async () => {
    const gm = await gmRect();
    landscape(gm.x - 200, gm.y - 100);
    const next = await writeAs(null, { text: '第二拍旁白。', reply_to: gm.id });
    expect(next.entry.y).toBeGreaterThanOrEqual(gm.y + gm.h);
  });
});
