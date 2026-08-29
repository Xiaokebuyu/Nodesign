/**
 * 「这一拍」锚定（2026-08-28 摆位直觉版；08-29 从 rounds 泛化到所有角色）：
 * 角色不给任何落位线索 = 它在回应主持人最新写的那一条 —— 缺省 reply_to 它，
 * 再经侧挂直觉落到它身侧。「章节竖着走、同一拍横着排」从回应语义里长出来，
 * 不是写死的版式。08-29 模式概念退役后这一级对所有角色一律成立。
 * 走真 handler + actor 盖章（署名链与 attribution 测试同款）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-roundsbeat-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { readBoard } = await import('../../../projects/board-store.js');
const { ensureProjectWorkspace, getWorkspaceRoot } = await import('../../../projects/workspace.js');
const { makeWriteOnBoardTool } = await import('./write-on-board.js');
const { makePreToolUseActorStamp } = await import('../../agent/hooks/pre-defaults.js');
const { _resetActorTrail } = await import('../../agent/actor-trail.js');
const { setViewpoint } = await import('../../../projects/viewpoint-store.js');
const { parseChalk } = await import('../../../lib/chalk.js');

const pid = 'proj_roundsbeat_test';
let ws;
const stamp = makePreToolUseActorStamp();
let n = 0;

beforeAll(async () => { await ensureProjectWorkspace(pid); ws = getWorkspaceRoot(pid); });

const writeAs = async (agentType, args) => {
  _resetActorTrail();
  const toolUseId = `toolu_rb_${n += 1}`;
  if (agentType) await stamp({ agent_id: 'a1', agent_type: agentType }, toolUseId);
  // 同一秒写两条板书文件名时间戳相同，路径排序认不出"最新" —— 用前后差集认新件
  const before = new Set(Object.keys((await readBoard(pid)).objects));
  const t = makeWriteOnBoardTool({ projectId: pid, sharedRoot: ws, sessionId: 's1', ctx: { emit() {} } });
  const r = await t.handler(args, { _meta: { 'claudecode/toolUseId': toolUseId } });
  expect(r.isError, r.content?.[0]?.text).toBeUndefined();
  const board = await readBoard(pid);
  const latest = Object.entries(board.objects)
    .find(([id, e]) => id.startsWith('notes/板书/') && e.by === (agentType || 'agent') && !before.has(id));
  return { board, latest };
};
const replyToOf = async (rel) => parseChalk(await fs.readFile(path.join(ws, rel), 'utf8')).chalk.replyTo;

describe('「这一拍」锚定', () => {
  it('⭐ 主持人落板后，角色无线索发言自动 reply_to 这一拍；横屏时侧挂到旁边', async () => {
    const gm = await writeAs(null, { text: '# 第一拍\n\n城门在暮色里合拢。', tag: '章节' });
    const [gmId, gmE] = gm.latest;
    // 横屏视点（侧挂直觉的前提）
    setViewpoint(pid, { camera: { x: gmE.x - 200, y: gmE.y - 100, w: 1600, h: 900 }, zoom: 1 });

    const a = await writeAs('rp-jian', { text: '「今夜风紧。」' });
    expect(await replyToOf(a.latest[0])).toBe(gmId);              // 缺省锚 = 本拍旁白
    expect(a.latest[1].y).toBeLessThan(gmE.y + gmE.h);            // 侧挂：不在正下方

    // 第二个角色同拍发言：同样锚到本拍，也在右半平面（同拍挤成一排）
    const b = await writeAs('rp-yue', { text: '「我去看看。」' });
    expect(await replyToOf(b.latest[0])).toBe(gmId);
    expect(b.latest[1].y).toBeLessThan(gmE.y + gmE.h);
  });

  it('主持人写了新的一拍之后，角色的缺省锚跟着换成最新那条', async () => {
    const gm2 = await writeAs(null, { text: '# 第二拍\n\n巡夜人举起了灯。', tag: '章节' });
    const c = await writeAs('rp-jian', { text: '「灯灭了一盏。」' });
    expect(await replyToOf(c.latest[0])).toBe(gm2.latest[0]);
  });

  it('角色自己给了 reply_to（比如回用户落痕那条）：它的手优先，缺省锚不抢', async () => {
    const userNote = 'notes/板书/20260827-090000-用户插话.md';
    await fs.mkdir(path.join(ws, 'notes/板书'), { recursive: true });
    await fs.writeFile(path.join(ws, userNote), '---\nnd: chalk\nby: user\n---\n等等，先别去。', 'utf8');
    const { patchBoard } = await import('../../../projects/board-store.js');
    await patchBoard(pid, { objects: { [userNote]: { x: 9000, y: 9000, w: 300, h: 100, by: 'user' } } });
    const r = await writeAs('rp-yue', { text: '「……好吧。」', reply_to: userNote });
    expect(await replyToOf(r.latest[0])).toBe(userNote);
  });

  it('板上还没有主持人的字（角色先开口）：不锚，正常落位', async () => {
    const pid2 = 'proj_roundsbeat_t2';
    await ensureProjectWorkspace(pid2);
    _resetActorTrail();
    await stamp({ agent_id: 'a1', agent_type: 'rp-jian' }, 'toolu_rb_first');
    const t = makeWriteOnBoardTool({ projectId: pid2, sharedRoot: getWorkspaceRoot(pid2), sessionId: 's1', ctx: { emit() {} } });
    const r = await t.handler({ text: '「有人吗？」' }, { _meta: { 'claudecode/toolUseId': 'toolu_rb_first' } });
    expect(r.isError).toBeUndefined();
    const board = await readBoard(pid2);
    const [rel] = Object.entries(board.objects).find(([id]) => id.startsWith('notes/板书/'));
    expect(parseChalk(await fs.readFile(path.join(getWorkspaceRoot(pid2), rel), 'utf8')).chalk.replyTo).toBeNull();
  });

});

describe('角色专线（08-28 预制摆位：GM open_lane 开线，角色只管补台词）', () => {
  it('⭐ GM 以角色 slug 开线后，角色无线索发言自动续进自己的线（tag 也着线）', async () => {
    const pid3 = 'proj_rolelane_t1';
    await ensureProjectWorkspace(pid3);
    const ws3 = getWorkspaceRoot(pid3);
    const t = makeWriteOnBoardTool({ projectId: pid3, sharedRoot: ws3, sessionId: 's1', ctx: { emit() {} } });
    const head = await t.handler({ text: '# 程晚的线\n\n她的故事从这里开始。', tag: 'rp-wan', open_lane: 'fresh' }, {});
    expect(head.isError, head.content?.[0]?.text).toBeUndefined();
    const headId = Object.keys((await readBoard(pid3)).objects).find((id) => id.startsWith('notes/板书/'));

    _resetActorTrail();
    await stamp({ agent_id: 'a9', agent_type: 'rp-wan' }, 'toolu_lane_1');
    const r = await t.handler({ text: '「我到了。」' }, { _meta: { 'claudecode/toolUseId': 'toolu_lane_1' } });
    expect(r.isError, r.content?.[0]?.text).toBeUndefined();
    const board = await readBoard(pid3);
    const [rel, e] = Object.entries(board.objects).find(([id, v]) => id.startsWith('notes/板书/') && v.by === 'rp-wan');
    expect(parseChalk(await fs.readFile(path.join(ws3, rel), 'utf8')).chalk.replyTo).toBe(headId);
    expect(e.tag).toBe('rp-wan');

    // 第二条继续续线。锚在线内成员上（同秒写入时文件名时间戳同前缀、路径序分不出
    // 先后 —— 真会话拍与拍隔秒级以上，"线内最新"即自己上一条；这里只钉"不出线"）
    _resetActorTrail();
    await stamp({ agent_id: 'a9', agent_type: 'rp-wan' }, 'toolu_lane_2');
    const r2 = await t.handler({ text: '「门没锁。」' }, { _meta: { 'claudecode/toolUseId': 'toolu_lane_2' } });
    expect(r2.isError).toBeUndefined();
    const board2 = await readBoard(pid3);
    const mine = Object.entries(board2.objects)
      .filter(([id, v]) => id.startsWith('notes/板书/') && v.by === 'rp-wan')
      .map(([id]) => id).sort();
    const anchor2 = parseChalk(await fs.readFile(path.join(ws3, mine[1]), 'utf8')).chalk.replyTo;
    expect([headId, mine[0]]).toContain(anchor2);
  });

  it('⭐ 登记表里的展示名开的线也认（listRoleNames 桥）', async () => {
    const pid4 = 'proj_rolelane_t2';
    await ensureProjectWorkspace(pid4);
    const ws4 = getWorkspaceRoot(pid4);
    await fs.mkdir(path.join(ws4, '.nd'), { recursive: true });
    await fs.writeFile(path.join(ws4, '.nd', 'cast.json'),
      JSON.stringify({ version: 1, roles: { 'rp-wan2': { name: '晚晚', pen: 'character', card: '角色/晚晚/角色卡.md' } } }), 'utf8');
    const t = makeWriteOnBoardTool({ projectId: pid4, sharedRoot: ws4, sessionId: 's1', ctx: { emit() {} } });
    const head = await t.handler({ text: '# 晚晚的线', tag: '晚晚', open_lane: 'fresh' }, {});
    expect(head.isError, head.content?.[0]?.text).toBeUndefined();
    const headId = Object.keys((await readBoard(pid4)).objects).find((id) => id.startsWith('notes/板书/'));
    _resetActorTrail();
    await stamp({ agent_id: 'a8', agent_type: 'rp-wan2' }, 'toolu_lane_3');
    const r = await t.handler({ text: '「来了来了。」' }, { _meta: { 'claudecode/toolUseId': 'toolu_lane_3' } });
    expect(r.isError, r.content?.[0]?.text).toBeUndefined();
    const board = await readBoard(pid4);
    const [rel, e] = Object.entries(board.objects).find(([id, v]) => id.startsWith('notes/板书/') && v.by === 'rp-wan2');
    expect(parseChalk(await fs.readFile(path.join(ws4, rel), 'utf8')).chalk.replyTo).toBe(headId);
    expect(e.tag).toBe('晚晚');
  });

  it('没开线的角色不受影响（free 场无锚照旧）', async () => {
    const pid5 = 'proj_rolelane_t3';
    await ensureProjectWorkspace(pid5);
    const t = makeWriteOnBoardTool({ projectId: pid5, sharedRoot: getWorkspaceRoot(pid5), sessionId: 's1', ctx: { emit() {} } });
    _resetActorTrail();
    await stamp({ agent_id: 'a7', agent_type: 'rp-solo' }, 'toolu_lane_4');
    const r = await t.handler({ text: '「独角戏。」' }, { _meta: { 'claudecode/toolUseId': 'toolu_lane_4' } });
    expect(r.isError).toBeUndefined();
    const board = await readBoard(pid5);
    const [rel] = Object.entries(board.objects).find(([id, v]) => id.startsWith('notes/板书/') && v.by === 'rp-solo');
    expect(parseChalk(await fs.readFile(path.join(getWorkspaceRoot(pid5), rel), 'utf8')).chalk.replyTo).toBeNull();
  });
});

describe('控件围栏自愈（08-28 泉此方案：裸 nd:controls 开头补围栏）', () => {
  it('裸文本控件被包上 ```nd:controls；已有围栏/普通正文不动', async () => {
    const pid6 = 'proj_ctlfence_t1';
    await ensureProjectWorkspace(pid6);
    const ws6 = getWorkspaceRoot(pid6);
    const t = makeWriteOnBoardTool({ projectId: pid6, sharedRoot: ws6, sessionId: 's1', ctx: { emit() {} } });
    const r = await t.handler({ text: 'nd:controls\nsupersede: 章节选项\n- [A] 跟上去 -> 选A' }, {});
    expect(r.isError, r.content?.[0]?.text).toBeUndefined();
    const board = await readBoard(pid6);
    const [rel] = Object.entries(board.objects).find(([id]) => id.startsWith('notes/板书/'));
    const bodyTxt = await fs.readFile(path.join(ws6, rel), 'utf8');
    expect(bodyTxt).toContain('```nd:controls');
    expect(bodyTxt.match(/```/g).length).toBe(2);

    const r2 = await t.handler({ text: '正文里提到 nd:controls 这个词不该被包。' }, {});
    expect(r2.isError).toBeUndefined();
    const board2 = await readBoard(pid6);
    const other = Object.keys(board2.objects).filter((id) => id.startsWith('notes/板书/') && id !== rel);
    const body2 = await fs.readFile(path.join(ws6, other[0]), 'utf8');
    expect(body2).not.toContain('```');
  });
});
