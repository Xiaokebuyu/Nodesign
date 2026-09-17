/**
 * engine/runs/user-messages.js 的数据层（09-17，数据丢失调查 1b）：
 *   1. 剥注入：拿真 composeUserMessage 拼出来的 displayText 对拍（composer 改了形状这里会红）；
 *      08-21 之前的旧形状（素材摘要 <system> 块、评论提示行）也要剥干净。
 *   2. 回合结局：按 session-loop / sweepOrphanRuns 真写进去的 status + error 判。
 *   3. 查询：只限本项目、排除演出行、按时间旧→新。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-usermsg-data-'));
process.env.DB_PATH = path.join(tmp, 'test.db');

const { cleanBrief, turnOutcome, listUserMessages, getUserMessage } = await import('./user-messages.js');
const { default: db, createRun, markRunStarted, markRunSucceeded, markRunFailed, sweepOrphanRuns, getRun } = await import('./store.js');
const { composeUserMessage } = await import('../../api/turn-compose.js');

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const setTime = (id, t) => db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(t, id);

describe('cleanBrief —— 对拍真 composer', () => {
  let desk;
  beforeAll(async () => {
    desk = path.join(tmp, 'desk');
    await fs.mkdir(path.join(desk, '用户内容'), { recursive: true });
    await fs.writeFile(path.join(desk, '用户内容', '参考.png'), PNG_1PX);
    await fs.writeFile(path.join(desk, '用户内容', '第二张.png'), PNG_1PX);
    await fs.writeFile(path.join(desk, '用户内容', '标志.svg'), '<svg/>');
    await fs.writeFile(path.join(desk, '用户内容', '需求.docx'), 'PK');
  });

  const ATTACHMENTS = [
    { path: '用户内容/参考.png', name: '参考.png', mime: 'image/png' },
    { path: '用户内容/第二张.png', name: '第二张.png', mime: 'image/png' },
    { path: '用户内容/标志.svg', name: '标志.svg', mime: 'image/svg+xml' },
    { path: '用户内容/需求.docx', name: '需求.docx' },
    { type: 'anchor', pageIndex: 1, tag: 'h1', text: '标题' },
    { type: 'comment', text: '这里太挤', anchor: { page: 1 } },
  ];

  it('待处理摘要 + 全部附件种类都剥掉，只剩用户写的字，附件按件计数', async () => {
    const chat = '第一段：把首页改成暖色。\n\n第二段：[参考] 标题别用衬线。\n- 这一行是用户自己写的列表';
    const { displayText, blocks } = await composeUserMessage(chat, ATTACHMENTS, { count: 2, summary: '用户在画布上改了 2 处' }, { desk, cwd: desk });
    // 判据自检：拼出来的确实带着每一种注入块，否则下面的断言恒真
    expect(blocks.filter((b) => b.type === 'image')).toHaveLength(2);
    for (const s of ['<system>', '[image]', '[已直接附上 2 张参考图', '可用素材（用 Read 工具读取', 'Office 文档（**用 mcp__nodesign__read_document 读', '- 评论: 这里太挤']) {
      expect(displayText).toContain(s);
    }
    expect(cleanBrief(displayText)).toEqual({ text: chat, attachments: 6 });
  });

  it('桌面与 cwd 分开（仓库项目）时的素材行照样剥', async () => {
    const { displayText } = await composeUserMessage('看看这个图标', [ATTACHMENTS[2]], null, { desk, cwd: path.join(tmp, 'repo') });
    expect(displayText).toContain('给的是绝对路径');
    expect(cleanBrief(displayText)).toEqual({ text: '看看这个图标', attachments: 1 });
  });

  it('只发附件：代填的那句不算用户的话', async () => {
    const { displayText } = await composeUserMessage('   ', [ATTACHMENTS[0]], null, { desk, cwd: desk });
    expect(displayText).toContain('[用户只发了附件');
    expect(cleanBrief(displayText)).toEqual({ text: '', attachments: 1 });
  });

  it('没有附件、没有摘要：原样返回', async () => {
    const { displayText } = await composeUserMessage('就一句话', [], { count: 0, summary: '' }, { desk, cwd: desk });
    expect(cleanBrief(displayText)).toEqual({ text: '就一句话', attachments: 0 });
  });

  it('08-21 之前的旧形状：两块 <system>（待处理 + 素材摘要，含换行）与评论提示行', () => {
    const old = [
      '<system>用户在画布上改了 1 处。可调 mcp__nodesign__get_pending_changes 查看详情</system>',
      '<system>工作区有 3 个素材。建议挑 1 张关键图 Read 看一眼\n完整路径：\n- assets/a.png</system>',
      '按评论改一下',
      '可用素材（用 Read 工具读取，路径相对 workspace）：\n- 评论: 字太小 (anchor: {})',
      '[评论提示 — 改前可以回看最近 decisions（hook 已注入摘要 / 细节去 Read spec.json）；如果改动方向不确定，跟用户点一下]',
    ].join('\n\n');
    expect(cleanBrief(old)).toEqual({ text: '按评论改一下', attachments: 1 });
  });

  it('用户正文中间出现的同样字样不动（只剥开头与结尾的注入块）', () => {
    const t = '我想问：\n\n[image]\n\n这个占位是什么意思？';
    expect(cleanBrief(t)).toEqual({ text: t, attachments: 0 });
  });
});

describe('turnOutcome —— 按真实写入路径判', () => {
  const mk = (brief = 'x') => createRun({ skillId: 'deskskill-engine-mini', brief, projectId: 'proj_outcome', sessionId: 's-outcome' });

  it('成功 / 中断（finishTurn 的 cancelled: 前缀）/ 失败 / 进行中 / 服务重启 / 排队未执行', () => {
    const restarted = mk();
    markRunStarted(restarted.id);
    sweepOrphanRuns();   // 模拟重启：此刻库里只有这一条在飞
    expect(turnOutcome(getRun(restarted.id))).toBe('中断（服务重启）');

    const ok = mk(); markRunStarted(ok.id); markRunSucceeded(ok.id, {});
    const stopped = mk(); markRunStarted(stopped.id); markRunFailed(stopped.id, 'cancelled: aborted_streaming');
    const failed = mk(); markRunStarted(failed.id); markRunFailed(failed.id, 'API Error: 529 overloaded\n  at upstream');
    const queued = mk(); markRunFailed(queued.id, 'session ended before queued turn started');
    const running = mk(); markRunStarted(running.id);
    expect(turnOutcome(getRun(ok.id))).toBe('成功');
    expect(turnOutcome(getRun(stopped.id))).toBe('中断');
    expect(turnOutcome(getRun(failed.id))).toBe('失败：API Error: 529 overloaded at upstream');
    expect(turnOutcome(getRun(queued.id))).toBe('失败（排队时会话已结束，没有执行）');
    expect(turnOutcome(getRun(running.id))).toBe('进行中');
    expect(turnOutcome({ status: 'cancelled' })).toBe('中断');
    expect(turnOutcome({ status: 'failed', error: null })).toBe('失败');
  });
});

describe('listUserMessages / getUserMessage —— 项目限定与排序', () => {
  it('只返回本项目、排除演出行、旧→新；别的项目的 sessionId / runId 查不到', () => {
    const a1 = createRun({ skillId: 'site-craft', brief: 'A 项目第一条', projectId: 'proj_scope_a', sessionId: 'sa' });
    const a2 = createRun({ skillId: 'site-craft', brief: 'A 项目第二条', projectId: 'proj_scope_a', sessionId: 'sa' });
    const b1 = createRun({ skillId: 'site-craft', brief: 'B 项目的秘密', projectId: 'proj_scope_b', sessionId: 'sb' });
    const st = createRun({ skillId: 'stage', brief: '台上的一句', projectId: 'proj_scope_a', sessionId: 'stage-sid' });
    const ca = createRun({ skillId: 'chatai', brief: '演出端点的一句', projectId: 'proj_scope_a' });
    setTime(a2.id, '2026-09-10 10:00:00');
    setTime(a1.id, '2026-09-10 09:00:00');
    setTime(b1.id, '2026-09-10 09:30:00');
    setTime(st.id, '2026-09-10 09:40:00');
    setTime(ca.id, '2026-09-10 09:45:00');

    const { items, hasMore } = listUserMessages({ projectId: 'proj_scope_a', limit: 10 });
    expect(items.map((i) => i.text)).toEqual(['A 项目第一条', 'A 项目第二条']);
    expect(hasMore).toBe(false);
    expect(listUserMessages({ projectId: 'proj_scope_a', sessionId: 'sb', limit: 10 }).items).toEqual([]);
    expect(getUserMessage({ projectId: 'proj_scope_a', runId: b1.id })).toBeNull();
    expect(getUserMessage({ projectId: 'proj_scope_a', runId: st.id })).toBeNull();
    expect(getUserMessage({ projectId: 'proj_scope_b', runId: b1.id })?.text).toBe('B 项目的秘密');
    expect(() => listUserMessages({ projectId: null, limit: 5 })).toThrow(/projectId/);
    expect(() => getUserMessage({ projectId: '', runId: b1.id })).toThrow(/projectId/);
  });

  it('limit 取最近的 N 条并报告更早还有；query 只在剥过的正文里匹配（LIKE 通配符按字面）', () => {
    const pid = 'proj_limit';
    const ids = ['一', '二', '三', '四'].map((n, i) => {
      const r = createRun({ skillId: 'x', brief: `第${n}条 Blue 100%_off`, projectId: pid, sessionId: 's' });
      setTime(r.id, `2026-09-11 0${i}:00:00`);
      return r.id;
    });
    const hidden = createRun({ skillId: 'x', brief: '没写那个词\n\n可用素材（用 Read 工具读取，路径相对 cwd）：\n- blue.png（blue.png）', projectId: pid, sessionId: 's' });
    setTime(hidden.id, '2026-09-11 05:00:00');

    const r = listUserMessages({ projectId: pid, limit: 2 });
    expect(r.items.map((i) => i.runId)).toEqual([ids[3], hidden.id]);
    expect(r.hasMore).toBe(true);
    const q = listUserMessages({ projectId: pid, query: 'blue', limit: 10 });
    expect(q.items.map((i) => i.runId)).toEqual(ids);   // 附件文件名里的 blue 不算
    expect(listUserMessages({ projectId: pid, query: '0%_o', limit: 10 }).items).toHaveLength(4);
    expect(listUserMessages({ projectId: pid, query: '0_%', limit: 10 }).items).toHaveLength(0);
    expect(listUserMessages({ projectId: pid, sinceSql: '2026-09-11 02:00:00', limit: 10 }).items.map((i) => i.runId)).toEqual([ids[2], ids[3], hidden.id]);
  });
});
