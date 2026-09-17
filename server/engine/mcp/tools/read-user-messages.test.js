/**
 * read_user_messages（09-17，数据丢失调查 1b；问题库 iss_mtxylgs4_xmmz、iss_mtvaq77w_xfa8）：
 *   1. ⛔ 项目限定：绑 A 的工具读不到 B 的任何内容 —— 传 B 的 sessionId、B 的 runId、多塞一个 projectId 都不行
 *   2. 输出：旧→新、每条带北京时间 / 会话 / 回合结局 / runId，注入块剥掉、附件只留件数
 *   3. 截断标明，runId + offset 能把全文分页读完
 *   4. 过滤参数：sessionId / since / query / limit
 *   5. 装配：两种模式都注册、打了 readOnlyHint 与检索关键词、不常驻
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-readusermsgs-'));
process.env.DB_PATH = path.join(tmp, 'test.db');

const { makeReadUserMessagesTool, parseSince, beijingTime } = await import('./read-user-messages.js');
const { default: db, createRun, markRunStarted, markRunSucceeded, markRunFailed } = await import('../../runs/store.js');
const { createNodesignMcpServer, ALWAYS_LOAD_TOOLS } = await import('../index.js');

const SID_A1 = '11111111-1111-4111-8111-111111111111';
const SID_A2 = '22222222-2222-4222-8222-222222222222';
const SID_B = '33333333-3333-4333-8333-333333333333';

function seed(projectId, sessionId, brief, createdAt, end = 'ok') {
  const r = createRun({ skillId: 'deskskill-engine-mini', brief, projectId, userId: `u_${projectId}`, sessionId });
  db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(createdAt, r.id);
  if (end === 'pending') return r.id;
  markRunStarted(r.id);
  if (end === 'ok') markRunSucceeded(r.id, {});
  else if (end === 'cancel') markRunFailed(r.id, 'cancelled: aborted_tools');
  else if (end === 'fail') markRunFailed(r.id, 'API Error: 500');
  return r.id;
}
const call = async (tool, args = {}) => {
  const r = await tool.handler(args);
  return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
};

const PA = 'proj_usermsg_a';
const PB = 'proj_usermsg_b';
const a1 = seed(PA, SID_A1, '<system>用户在画布上改了 1 处。可调 mcp__nodesign__get_pending_changes 查看详情</system>\n\n先做一版暖色的首页', '2026-09-15 01:00:00');
const a2 = seed(PA, SID_A1, '标题换成楷体\n\n[image]\n\n[已直接附上 1 张参考图：参考.png —— 你可以直接 vision 看，不需要再 Read]', '2026-09-15 02:00:00', 'cancel');
const a3 = seed(PA, SID_A2, '第二次对话：配色再冷一点', '2026-09-16 03:30:00', 'fail');
const a4 = seed(PA, SID_A2, '[用户只发了附件，没有附带文字。先看附件再问他想拿它做什么]\n\n可用素材（用 Read 工具读取，路径相对 cwd）：\n- 用户内容/需求.txt（需求.txt）', '2026-09-16 04:00:00', 'pending');
const b1 = seed(PB, SID_B, 'B 项目的私密需求：别让别人看到', '2026-09-15 01:30:00');
const B_SECRET = 'B 项目的私密需求';

const toolA = makeReadUserMessagesTool({ projectId: PA, sessionId: SID_A2 });

describe('read_user_messages —— ⛔ 项目限定', () => {
  it('默认列表只有 A 的消息', async () => {
    const { text } = await call(toolA);
    expect(text).not.toContain(B_SECRET);
    expect(text).not.toContain(SID_B);
    expect(text).not.toContain(b1);
    for (const id of [a1, a2, a3, a4]) expect(text).toContain(id);
  });

  it('传 B 的 sessionId：读不到，也不透露那个会话在别处存在', async () => {
    const { text, isError } = await call(toolA, { sessionId: SID_B });
    expect(isError).toBe(false);
    expect(text).not.toContain(B_SECRET);
    expect(text).toContain('本项目里没有会话');
    const { text: ghost } = await call(toolA, { sessionId: '99999999-9999-4999-8999-999999999999' });
    expect(ghost.replace(/[0-9a-f-]{36}/g, 'SID')).toBe(text.replace(/[0-9a-f-]{36}/g, 'SID'));
  });

  it('传 B 的 runId：读不到', async () => {
    const { text, isError } = await call(toolA, { runId: b1 });
    expect(isError).toBe(true);
    expect(text).not.toContain(B_SECRET);
  });

  it('模型多塞 projectId 无效：仍按构造时绑定的项目读', async () => {
    const { text } = await call(toolA, { projectId: PB, sessionId: SID_B });
    expect(text).not.toContain(B_SECRET);
    const { text: t2 } = await call(toolA, { projectId: PB });
    expect(t2).not.toContain(B_SECRET);
    expect(t2).toContain(a1);
    // schema 里就没有这个键（SDK 按 schema 剥掉未知键，模型传了也到不了 handler）
    expect(Object.keys(toolA.inputSchema)).not.toContain('projectId');
  });

  it('没绑项目：直接报错，不去查全表', async () => {
    const { isError, text } = await call(makeReadUserMessagesTool({ projectId: null }));
    expect(isError).toBe(true);
    expect(text).not.toContain(B_SECRET);
  });

  it('B 的工具只看得到 B（对照：数据确实在库里）', async () => {
    const { text } = await call(makeReadUserMessagesTool({ projectId: PB }));
    expect(text).toContain(B_SECRET);
    expect(text).not.toContain('暖色');
  });
});

describe('read_user_messages —— 输出形状', () => {
  it('旧→新，每条带北京时间、会话、结局、runId；注入块剥掉，附件只留件数', async () => {
    const { text } = await call(toolA);
    const order = [a1, a2, a3, a4].map((id) => text.indexOf(id));
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(text).toContain(`── 1 · 2026-09-15 09:00 · 会话 11111111 · 成功 · ${a1}\n先做一版暖色的首页`);
    expect(text).toContain(`── 2 · 2026-09-15 10:00 · 会话 11111111 · 中断 · ${a2}\n标题换成楷体\n〔另附 1 件附件，附件说明已略〕`);
    expect(text).toContain(`── 3 · 2026-09-16 11:30 · 会话 22222222（本会话） · 失败：API Error: 500 · ${a3}`);
    expect(text).toContain(`── 4 · 2026-09-16 12:00 · 会话 22222222（本会话） · 进行中 · ${a4}\n（只发了附件，没有文字）\n〔另附 1 件附件，附件说明已略〕`);
    for (const s of ['<system>', 'get_pending_changes', '[image]', '已直接附上', '可用素材', '用户只发了附件']) expect(text).not.toContain(s);
    expect(text).toContain(`会话全名（传 sessionId 用）：${SID_A1}、${SID_A2}（本会话）`);
  });

  it('长消息截断并标明，runId 读全文，offset 分页读到结尾', async () => {
    const PL = 'proj_usermsg_long';
    // 20005 个码点；emoji 落在第 12000 个码点上，按 UTF-16 切会切成半个
    const long = `开头${'长'.repeat(11997)}😀${'长'.repeat(8003)}结尾`;
    const id = seed(PL, SID_A1, long, '2026-09-15 05:00:00');
    const tool = makeReadUserMessagesTool({ projectId: PL });
    const { text } = await call(tool);
    expect(text).toContain(`…〔原文共 20005 字，这里只列前 1500 字。读全文：read_user_messages { runId: "${id}" }〕`);
    expect(text).not.toContain('结尾');

    const p1 = await call(tool, { runId: id });
    expect(p1.text).toContain(`〔第 1–12000 字，共 20005 字。接着读：read_user_messages { runId: "${id}", offset: 12000 }〕`);
    expect(p1.text).toContain(`会话 ${SID_A1}`);
    const p2 = await call(tool, { runId: id, offset: 12000 });
    expect(p2.text).toContain('〔第 12001–20005 字，共 20005 字（到结尾）〕');
    const body = (t) => t.split('〕\n').slice(1).join('〕\n');
    expect(body(p1.text) + body(p2.text)).toBe(long);
    const over = await call(tool, { runId: id, offset: 20005 });
    expect(over.isError).toBe(true);

    const short = await call(toolA, { runId: a1 });
    expect(short.text).toContain('〔全文 9 字〕\n先做一版暖色的首页');
  });

  it('整批超篇幅时从最旧的开始省略，并说明', async () => {
    const PM = 'proj_usermsg_many';
    for (let i = 0; i < 30; i += 1) seed(PM, SID_A1, `第${i}条${'字'.repeat(1400)}`, `2026-09-15 06:${String(i).padStart(2, '0')}:00`);
    const { text } = await call(makeReadUserMessagesTool({ projectId: PM }), { limit: 30 });
    expect(text.length).toBeLessThan(26000);
    expect(text).toContain('第29条');
    expect(text).not.toContain('第0条');
    expect(text).toMatch(/更早的 \d+ 条因篇幅没有列出/);
  });
});

describe('read_user_messages —— 过滤参数', () => {
  it('sessionId 只看那一次对话', async () => {
    const { text } = await call(toolA, { sessionId: SID_A1 });
    expect(text).toContain(a1);
    expect(text).toContain(a2);
    expect(text).not.toContain(a3);
    expect(text).toContain(`（会话 ${SID_A1}）`);
  });

  it('since 按北京时间读；认不出的报错并给写法', async () => {
    const { text } = await call(toolA, { since: '2026-09-16' });   // = 09-15 16:00 UTC
    expect(text).not.toContain(a2);
    expect(text).toContain(a3);
    expect(text).toContain('2026-09-16 00:00 之后');
    const bad = await call(toolA, { since: '上周' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('3d');
  });

  it('query 不分大小写；limit 取最近的并提示更早还有', async () => {
    const q = await call(toolA, { query: '楷体' });
    expect(q.text).toContain(a2);
    expect(q.text).not.toContain(a1);
    const lim = await call(toolA, { limit: 1 });
    expect(lim.text).toContain(a4);
    expect(lim.text).not.toContain(a3);
    expect(lim.text).toContain('比这些更早的还有');
    const none = await call(toolA, { query: '不存在的词' });
    expect(none.text).toBe('本项目里没有符合条件的用户消息（包含「不存在的词」）。');
  });

  it('parseSince：相对时长、北京时间日期 / 时刻、带时区 ISO；非法输入 null', () => {
    const now = Date.parse('2026-09-17T00:00:00Z');
    expect(parseSince('30m', now)).toBe('2026-09-16 23:30:00');
    expect(parseSince('6h', now)).toBe('2026-09-16 18:00:00');
    expect(parseSince('3d', now)).toBe('2026-09-14 00:00:00');
    expect(parseSince('2026-09-15', now)).toBe('2026-09-14 16:00:00');
    expect(parseSince('2026-09-15 14:00', now)).toBe('2026-09-15 06:00:00');
    expect(parseSince('2026-09-15T14:00:30', now)).toBe('2026-09-15 06:00:30');
    expect(parseSince('2026-09-15T14:00:00Z', now)).toBe('2026-09-15 14:00:00');
    expect(parseSince('2026-09-15T14:00:00+09:00', now)).toBe('2026-09-15 05:00:00');
    for (const bad of ['', 'yesterday', '2026-13-01', '2026-09-15 25:00', '15/09/2026', '5 weeks']) expect(parseSince(bad, now)).toBeNull();
    expect(beijingTime('2026-09-15 16:30:00')).toBe('2026-09-16 00:30');
  });
});

describe('read_user_messages —— 装配', () => {
  it('两种模式都注册；readOnlyHint、检索关键词挂上；不常驻', () => {
    for (const projectMode of ['design', 'rp']) {
      const server = createNodesignMcpServer({ workspaceRoot: tmp, sharedRoot: tmp, projectId: PA, sessionId: SID_A2, projectMode });
      expect(server.toolNames).toContain('read_user_messages');
      expect(server.readOnlyToolNames).toContain('read_user_messages');
      expect(server.searchHintToolNames).toContain('read_user_messages');
    }
    expect(ALWAYS_LOAD_TOOLS.has('read_user_messages')).toBe(false);
  });

  it('走真 MCP 协议：工具定义里没有 projectId、标了只读；多塞 projectId 调用仍只读到本项目', async () => {
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const srv = createNodesignMcpServer({ workspaceRoot: tmp, sharedRoot: tmp, projectId: PA, sessionId: SID_A2, projectMode: 'design' });
    const [x, y] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    try {
      await srv.instance.connect(x); await client.connect(y);
      const def = (await client.listTools()).tools.find((t) => t.name === 'read_user_messages');
      expect(def.annotations?.readOnlyHint).toBe(true);
      expect(Object.keys(def.inputSchema.properties).sort()).toEqual(['limit', 'offset', 'query', 'runId', 'sessionId', 'since']);
      const r = await client.callTool({ name: 'read_user_messages', arguments: { projectId: PB, sessionId: SID_B } });
      const out = r.content.map((c) => c.text).join('\n');
      expect(out).not.toContain(B_SECRET);
      expect(out).toContain('本项目里没有会话');
      const r2 = await client.callTool({ name: 'read_user_messages', arguments: { projectId: PB, runId: b1 } });
      expect(r2.content.map((c) => c.text).join('\n')).not.toContain(B_SECRET);
      const r3 = await client.callTool({ name: 'read_user_messages', arguments: { projectId: PB } });
      const out3 = r3.content.map((c) => c.text).join('\n');
      expect(out3).toContain('先做一版暖色的首页');
      expect(out3).not.toContain(B_SECRET);
    } finally {
      try { await client.close(); } catch { /* */ }
      try { await srv.instance.close(); } catch { /* */ }
    }
  });
});
