/**
 * rounds 桌集成（2026-08-27 四模式版式）：轮次场里角色不给落位，机器按桌位排 ——
 * 自己的列往下续（走 reply_to 线程），首次开口在前一列右边开新列。
 * 走真 handler + actor 盖章（署名链与 attribution 测试同款）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-roundstable-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { readBoard } = await import('../../../projects/board-store.js');
const { ensureProjectWorkspace, getWorkspaceRoot } = await import('../../../projects/workspace.js');
const { makeWriteOnBoardTool } = await import('./write-on-board.js');
const { makePreToolUseActorStamp } = await import('../../agent/hooks/pre-defaults.js');
const { _resetActorTrail } = await import('../../agent/actor-trail.js');
const { setScene, _resetScenes } = await import('../../agent/scene.js');
const { parseChalk } = await import('../../../lib/chalk.js');

const pid = 'proj_roundstable_test';
let ws;
const stamp = makePreToolUseActorStamp();
let n = 0;

beforeAll(async () => { await ensureProjectWorkspace(pid); ws = getWorkspaceRoot(pid); });

const writeAs = async (agentType, args) => {
  _resetActorTrail();
  const toolUseId = `toolu_rt_${n += 1}`;
  if (agentType) await stamp({ agent_id: 'a1', agent_type: agentType }, toolUseId);
  // 同一秒写两条板书文件名时间戳相同，路径排序认不出"最新" —— 用前后差集认新件
  const before = new Set(Object.keys((await readBoard(pid)).objects));
  const t = makeWriteOnBoardTool({ projectId: pid, sharedRoot: ws, sessionId: 's1', ctx: { emit() {} } });
  const r = await t.handler(args, { _meta: { 'claudecode/toolUseId': toolUseId } });
  expect(r.isError, r.content?.[0]?.text).toBeUndefined();
  const board = await readBoard(pid);
  const latest = Object.entries(board.objects)
    .find(([id, e]) => id.startsWith('notes/板书/') && e.by === agentType && !before.has(id));
  return { board, latest };
};

describe('rounds 桌：机器排桌位', () => {
  it('⭐ 列续尾 + 新列开在前一列右边', async () => {
    _resetScenes();
    setScene(pid, { mode: 'rounds', order: ['rp-jian', 'rp-yue'] });

    // 全场第一个开口：没有提示，正常落位
    const a1 = await writeAs('rp-jian', { text: '「今夜风紧。」' });
    // 同一角色再开口：自动续在自己那条下面（reply_to 线程，没写 chain 也没写落位）
    const a2 = await writeAs('rp-jian', { text: '「城门那边有火光。」' });
    const fm2 = parseChalk(await fs.readFile(path.join(ws, a2.latest[0]), 'utf8')).chalk;
    expect(fm2.replyTo).toBe(a1.latest[0]);
    expect(a2.latest[1].y).toBeGreaterThan(a1.latest[1].y);

    // 另一个角色首次开口：列开在 rp-jian 列头右边
    const b1 = await writeAs('rp-yue', { text: '「我去看看。」' });
    const fmB = parseChalk(await fs.readFile(path.join(ws, b1.latest[0]), 'utf8')).chalk;
    expect(fmB.replyTo).toBeNull();   // 不是接楼，是开新列
    expect(b1.latest[1].x).toBeGreaterThan(a1.latest[1].x);
  });

  it('角色自己给了 reply_to（比如回用户落痕那条）：它的手优先，桌位不抢', async () => {
    const board = await readBoard(pid);
    const userNote = 'notes/板书/20260827-090000-用户插话.md';
    await fs.mkdir(path.join(ws, 'notes/板书'), { recursive: true });
    await fs.writeFile(path.join(ws, userNote), '---\nnd: chalk\nby: user\n---\n等等，先别去。', 'utf8');
    const { patchBoard } = await import('../../../projects/board-store.js');
    await patchBoard(pid, { objects: { [userNote]: { x: 9000, y: 9000, w: 300, h: 100, by: 'user' } } });
    const r = await writeAs('rp-yue', { text: '「……好吧。」', reply_to: userNote });
    const fm = parseChalk(await fs.readFile(path.join(ws, r.latest[0]), 'utf8')).chalk;
    expect(fm.replyTo).toBe(userNote);
    expect(Object.keys(board.objects).length).toBeGreaterThan(0);
  });

  it('非 rounds 场：不自动接线（free 的落位交给角色的 reply_to 纪律）', async () => {
    _resetScenes();
    setScene(pid, { mode: 'free' });
    const r = await writeAs('rp-jian', { text: '「散了吧。」' });
    const fm = parseChalk(await fs.readFile(path.join(ws, r.latest[0]), 'utf8')).chalk;
    expect(fm.replyTo).toBeNull();
  });
});
