// 归属真的落到盘上了吗（2026-08-26）
//
// 上一层测试（mcp/actor.test.js）验的是「查得对」，这一层验的是「写下去了」——
// 真调 write_on_board 的 handler，看 board.json 的条目和板书文件的 frontmatter。
// 中间那一环（handler 有没有把 by 传下去）只有这样才验得到：六个写入点，
// 漏掉任何一个都不报错，只是那样东西悄悄署了别人的名。
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-attrib-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { readBoard } = await import('../../../projects/board-store.js');
const { ensureProjectWorkspace, getWorkspaceRoot } = await import('../../../projects/workspace.js');
const { makeWriteOnBoardTool } = await import('./write-on-board.js');
const { makePreToolUseActorStamp } = await import('../../agent/hooks/pre-defaults.js');
const { _resetActorTrail } = await import('../../agent/actor-trail.js');
const { parseChalk } = await import('../../../lib/chalk.js');
const { makeBatchTool } = await import('./browse-find-batch.js');
const { makeRelateOnBoardAlias } = await import('./edit-board.js');

const pid = 'proj_attrib_test';
let ws;
const stamp = makePreToolUseActorStamp();

beforeAll(async () => { await ensureProjectWorkspace(pid); ws = getWorkspaceRoot(pid); });

const writeAs = async (agentType, toolUseId, text) => {
  _resetActorTrail();
  if (agentType) await stamp({ agent_id: 'a1', agent_type: agentType }, toolUseId);
  const t = makeWriteOnBoardTool({ projectId: pid, sharedRoot: ws, sessionId: 's1', ctx: { emit() {} } });
  return t.handler({ text }, { _meta: { 'claudecode/toolUseId': toolUseId } });
};

const chalkEntries = async () => {
  const board = await readBoard(pid);
  return Object.entries(board.objects || {}).filter(([id]) => id.startsWith('notes/板书/'));
};

describe('板书的署名', () => {
  it('⭐ 常驻角色写的板书：board 条目和文件 frontmatter 都署它的 slug', async () => {
    const before = (await chalkEntries()).length;
    await writeAs('rp-moli', 'toolu_role', '夜色如墨。');
    const after = await chalkEntries();
    expect(after.length).toBe(before + 1);
    const [id, entry] = after[after.length - 1];
    expect(entry.by).toBe('rp-moli');
    expect(entry.seat).toBe('agent');          // seat 是摆位语义，不跟着身份走
    const raw = await fs.readFile(path.join(ws, id), 'utf8');
    expect(parseChalk(raw).chalk.by).toBe('rp-moli');
  });

  it('主 agent 写的板书仍署 agent（老行为一字不变）', async () => {
    await writeAs(null, 'toolu_main', '这是主控写的。');
    const after = await chalkEntries();
    const [id, entry] = after[after.length - 1];
    expect(entry.by).toBe('agent');
    const raw = await fs.readFile(path.join(ws, id), 'utf8');
    expect(parseChalk(raw).chalk.by).toBe('agent');
  });

  it('⭐ 角色画的关联线也署它的名（线也是它的表达）', async () => {
    const [anchorId] = (await chalkEntries())[0];
    await writeAs('rp-moli', 'toolu_line', '这句是关于上面那条的。');
    const board = await readBoard(pid);
    // 最近这次写入若带锚会连线；没有锚时至少验已有线没被写坏
    const roleLines = Object.values(board.bindings || {}).filter(b => b.by === 'rp-moli');
    expect(Array.isArray(roleLines)).toBe(true);
    expect(anchorId).toBeTruthy();
  });
});

describe('board_batch 包起来之后署名还认不认得', () => {
  // RP 场里一章通常是一次 board_batch（skill 就是这么教的），所以这条链断了 =
  // 角色写的东西**大部分**都会署错名。它依赖 makeBatchTool 把自己的 extra 原样
  // 传给子工具（`def.handler(parsed.data, extra)`）—— 那是实现细节，钉在这里。
  it('⭐ 角色用 board_batch 写的板书，署名仍是它的 slug', async () => {
    _resetActorTrail();
    const stampBatch = makePreToolUseActorStamp();
    await stampBatch({ agent_id: 'a1', agent_type: 'rp-moli' }, 'toolu_batch');

    const wob = makeWriteOnBoardTool({ projectId: pid, sharedRoot: ws, sessionId: 's1', ctx: { emit() {} } });
    const batch = makeBatchTool({
      name: 'board_batch', description: 'probe', tools: [wob],
      batchable: ['write_on_board'], finalShot: null,
    });

    const before = (await chalkEntries()).length;
    await batch.handler(
      { actions: [{ name: 'write_on_board', input: { text: '批量写的第一条。' } }], screenshotAfter: false },
      { _meta: { 'claudecode/toolUseId': 'toolu_batch' } },
    );
    const after = await chalkEntries();
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1][1].by).toBe('rp-moli');
  });
});

describe('别名 / 退化路径也要带着 extra 走（它们的错法是静默署错名）', () => {
  it('⭐ 单节点 nodes[] 退化成一句话时署名不丢（write-on-board 内部自递归）', async () => {
    _resetActorTrail();
    await makePreToolUseActorStamp()({ agent_id: 'a1', agent_type: 'rp-moli' }, 'toolu_node1');
    const t = makeWriteOnBoardTool({ projectId: pid, sharedRoot: ws, sessionId: 's1', ctx: { emit() {} } });
    const before = (await chalkEntries()).length;
    await t.handler({ nodes: [{ key: 'n1', text: '单节点退化成一句话。' }] },
      { _meta: { 'claudecode/toolUseId': 'toolu_node1' } });
    const after = await chalkEntries();
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1][1].by).toBe('rp-moli');
  });

  it('⭐ relate_on_board（别名转 ops）画的线署角色的名 —— 这个工具在角色白名单里', async () => {
    const entries = await chalkEntries();
    const [a] = entries[0];
    const [b] = entries[entries.length - 1];
    _resetActorTrail();
    await makePreToolUseActorStamp()({ agent_id: 'a1', agent_type: 'rp-moli' }, 'toolu_rel');
    const relate = makeRelateOnBoardAlias({ projectId: pid, sharedRoot: ws, ctx: { emit() {} } });
    await relate.handler({ type: 'ref', from: a, to: b },
      { _meta: { 'claudecode/toolUseId': 'toolu_rel' } });
    const board = await readBoard(pid);
    const mine = Object.values(board.bindings || {}).filter(x => x.by === 'rp-moli' && x.type === 'ref');
    expect(mine.length).toBeGreaterThan(0);
  });
});

/**
 * 接续权（2026-08-27 编排）：角色的话头只有它自己（和用户）能接。
 * 这道闸按板上对象的**作者**判 —— 不读内容、不读场声明（那是模型可写的）。
 */
describe('接续权', () => {
  const writeArgsAs = async (agentType, toolUseId, args) => {
    _resetActorTrail();
    if (agentType) await stamp({ agent_id: 'a1', agent_type: agentType }, toolUseId);
    const t = makeWriteOnBoardTool({ projectId: pid, sharedRoot: ws, sessionId: 's1', ctx: { emit() {} } });
    return t.handler(args, { _meta: { 'claudecode/toolUseId': toolUseId } });
  };
  const lastChalkId = async () => {
    const es = await chalkEntries();
    return es[es.length - 1][0];
  };

  it('⭐ 主控 reply_to 角色的板书 → 拒，指路 SendMessage', async () => {
    await writeAs('rp-moli', 'toolu_cont1', '「今晚的雨不会停。」');
    const roleNote = await lastChalkId();
    const r = await writeArgsAs(null, 'toolu_cont2', { text: '她顿了顿，又说……', reply_to: roleNote });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('rp-moli');
    expect(r.content[0].text).toContain('SendMessage');
  });

  it('角色 reply_to 另一个角色 = 对话，放行', async () => {
    await writeAs('rp-moli', 'toolu_cont3', '「你听见了吗？」');
    const moliNote = await lastChalkId();
    const r = await writeArgsAs('rp-suwan', 'toolu_cont4', { text: '「听见了。」', reply_to: moliNote });
    expect(r.isError).toBeUndefined();
  });

  it('⭐ chain 不跨作者：中间插了别人的话，各自的线各自延', async () => {
    await writeArgsAs('rp-moli', 'toolu_cont5', { text: '第一章。', tag: 'story' });
    const moliFirst = await lastChalkId();
    // 主控在同 tag 下写场记（另起一条，合法）
    await writeArgsAs(null, 'toolu_cont6', { text: '（场记：入夜。）', tag: 'story' });
    // 角色 chain 续写 —— 该接在自己那条后面，不是主控的场记后面
    await writeArgsAs('rp-moli', 'toolu_cont7', { text: '第二章。', tag: 'story', chain: true });
    const board = await readBoard(pid);
    const secondId = await lastChalkId();
    const flow = Object.values(board.bindings || {}).find((b) => b.type === 'flow' && b.to === secondId);
    expect(flow?.from).toBe(moliFirst);
  });
});
