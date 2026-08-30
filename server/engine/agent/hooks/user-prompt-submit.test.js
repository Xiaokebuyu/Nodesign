/**
 * 每轮状态注入：首轮全量、之后只报变化（2026-08-21）。
 * renderTurnState 是纯函数；handler 那条用临时工作区真跑两轮。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderTurnState, makeUserPromptSubmitHandler } from './user-prompt-submit.js';
import { resetTurnMemory, diffItems, fingerprint } from './turn-state-memory.js';
import { renderChalk, CHALK_DIR } from '../../../lib/chalk.js';
import { STATE_TABLE_TAG } from '../../../lib/state-table.js';

const sec = (key, text, items) => ({ key, title: key, text, ...(items ? { items } : {}) });

describe('renderTurnState', () => {
  it('首轮全量 + 结尾那句；记忆里每节有指纹', () => {
    const r = renderTurnState([sec('cwd', 'cwd=/x'), sec('notes', '便利贴：a', ['a'])], null);
    expect(r.text).toMatch(/^\[NoDesign 工作台自动注入的当前状态\]/);
    expect(r.text).toMatch(/cwd=\/x/);
    expect(r.text).toMatch(/请基于这些信息处理用户的请求/);
    expect(r.next.get('notes').items).toEqual(['a']);
  });
  it('一节都没变 → 一句话', () => {
    const s = [sec('cwd', 'cwd=/x'), sec('notes', '便利贴：a', ['a'])];
    const first = renderTurnState(s, null);
    const second = renderTurnState(s, first.next);
    expect(second.text).toBe('[工作台状态：与上轮相同（cwd、notes）]');
  });
  it('清单类只报新增/移除，非清单类变了报全文，没变的只点名', () => {
    const first = renderTurnState([sec('cwd', 'cwd=/x'), sec('assets', '素材 2 件', ['a', 'b']), sec('artifacts', '产物：p1')], null);
    const second = renderTurnState([sec('cwd', 'cwd=/x'), sec('assets', '素材 3 件', ['a', 'c', 'd']), sec('artifacts', '产物：p1 p2')], first.next);
    expect(second.text).toMatch(/^\[工作台状态 · 只报变化\]/);
    expect(second.text).toMatch(/assets（有变化）：新增 2：c、d；移除 1：b（现共 3 件）/);
    expect(second.text).toMatch(/（有变化）产物：p1 p2/);
    expect(second.text).toMatch(/未变：cwd/);
    expect(second.text).not.toMatch(/素材 3 件/);   // 清单类不重复全文
  });
  it('新出现 / 已不存在 的节', () => {
    const first = renderTurnState([sec('cwd', 'cwd=/x'), sec('tweaks', '开')], null);
    const second = renderTurnState([sec('cwd', 'cwd=/x'), sec('notes', '便利贴：a', ['a'])], first.next);
    expect(second.text).toMatch(/（新出现）便利贴：a/);
    expect(second.text).toMatch(/已不存在：tweaks/);
  });
  it('diffItems / fingerprint', () => {
    expect(diffItems(['a', 'b'], ['b', 'c'])).toEqual({ added: ['c'], removed: ['a'] });
    expect(fingerprint('x')).toBe(fingerprint('x'));
    expect(fingerprint('x')).not.toBe(fingerprint('y'));
  });
});

describe('handler 真跑两轮（临时工作区）', () => {
  it('第二轮"与上轮相同"；加一张便利贴后第三轮只报那一节', async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-ups-'));
    await fs.mkdir(path.join(ws, 'notes'));
    await fs.writeFile(path.join(ws, 'notes', 'a.md'), '# 第一张\n\n内容');
    const sid = `test-${Date.now()}`;
    resetTurnMemory(sid);
    const h = makeUserPromptSubmitHandler({ workspaceRoot: ws, sessionId: sid, projectId: 'proj_ups_test0001' });
    const r1 = (await h({ prompt: 'hi' }, 't', {})).hookSpecificOutput.additionalContext;
    expect(r1).toMatch(/^\[NoDesign 工作台自动注入的当前状态\]/);
    expect(r1).toMatch(/notes\/a\.md（第一张）/);
    const r2 = (await h({ prompt: 'hi' }, 't', {})).hookSpecificOutput.additionalContext;
    expect(r2).toMatch(/^\[工作台状态：与上轮相同/);
    expect(r2.length).toBeLessThan(r1.length / 3);
    await fs.writeFile(path.join(ws, 'notes', 'b.md'), '# 第二张');
    const r3 = (await h({ prompt: 'hi' }, 't', {})).hookSpecificOutput.additionalContext;
    expect(r3).toMatch(/便利贴（有变化）：新增 1：notes\/b\.md/);
    expect(r3).not.toMatch(/notes\/a\.md（第一张）/);   // 没变的贴不再重复
    resetTurnMemory(sid);
    await fs.rm(ws, { recursive: true, force: true });
  });
});

/**
 * 状态表这一节（2026-08-30）——「装了闸就真去攻一遍」。
 * 两条判据都是给机制本身的探针：set 了下一轮看得见（活着），表改坏了下一轮出声（没哑）。
 */
describe('⭐ 状态表节：两条判据都真跑一遍', () => {
  const T = (...rows) => ['| 键 | 值 |', '| --- | --- |', ...rows].join('\n');
  const mk = async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-ups-vars-'));
    await fs.mkdir(path.join(ws, CHALK_DIR), { recursive: true });
    return ws;
  };
  const put = (ws, body) => fs.writeFile(
    path.join(ws, CHALK_DIR, '20260830-100000-状态.md'),
    renderChalk({ body, by: 'agent', tag: STATE_TABLE_TAG }),
  );

  it('表里的值出现在状态块里；值一改，下一轮就带着新值来', async () => {
    const ws = await mk();
    await put(ws, T('| 好感度_苏绵 | 3 |', '| 时间 | 戌时 |'));
    const sid = `test-vars-${Date.now()}`;
    resetTurnMemory(sid);
    const h = makeUserPromptSubmitHandler({ workspaceRoot: ws, sessionId: sid, projectId: 'proj_vars_test0001' });
    const r1 = (await h({ prompt: 'hi' }, 't', {})).hookSpecificOutput.additionalContext;
    expect(r1).toMatch(/状态表现值/);
    expect(r1).toMatch(/好感度_苏绵 = 3/);

    await put(ws, T('| 好感度_苏绵 | 5 |', '| 时间 | 戌时 |'));
    const r2 = (await h({ prompt: 'hi' }, 't', {})).hookSpecificOutput.additionalContext;
    expect(r2).toMatch(/好感度_苏绵 = 5/);
    // 不给 items → 走整节 hash 比对，变了就报整表现值（不是「新增/移除」那套措辞）
    expect(r2).not.toMatch(/新增 1：好感度/);
    resetTurnMemory(sid);
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('⛔ 把表改坏 → 下一轮状态块里必须出现报警（不许静默消失）', async () => {
    const ws = await mk();
    await put(ws, T('| a | 1 |'));
    const sid = `test-vars-broken-${Date.now()}`;
    resetTurnMemory(sid);
    const h = makeUserPromptSubmitHandler({ workspaceRoot: ws, sessionId: sid, projectId: 'proj_vars_test0002' });
    expect((await h({ prompt: 'hi' }, 't', {})).hookSpecificOutput.additionalContext).toMatch(/a = 1/);

    await put(ws, T('| a | 1 |', '| a | 2 |'));     // 用户手改出来的重复键
    const r2 = (await h({ prompt: 'hi' }, 't', {})).hookSpecificOutput.additionalContext;
    expect(r2, '坏了必须出声').toMatch(/状态表读不出来了/);
    expect(r2).toMatch(/出现了两次/);
    resetTurnMemory(sid);
    await fs.rm(ws, { recursive: true, force: true });
  });
});

describe('⭐ 条件触发器：端到端真跑（求值点=注入点）', () => {
  const T = (...rows) => ['| 键 | 值 |', '| --- | --- |', ...rows].join('\n');
  const withTrig = (...rows) => `${T(...rows)}\n\n\`\`\`nd:triggers\n- [好感度 >= 5] once -> 她开始主动找你说话了\n\`\`\``;

  it('首轮上膛不击发；值穿过阈值那一轮才响；再下一轮不重复响', async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-trig-'));
    await fs.mkdir(path.join(ws, CHALK_DIR), { recursive: true });
    const put = (b) => fs.writeFile(
      path.join(ws, CHALK_DIR, '20260830-100000-状态.md'),
      renderChalk({ body: b, by: 'agent', tag: STATE_TABLE_TAG }),
    );
    const sid = `test-trig-${Date.now()}`;
    resetTurnMemory(sid);
    const h = makeUserPromptSubmitHandler({ workspaceRoot: ws, sessionId: sid, projectId: 'proj_trig_test0001' });

    // ① 首轮：条件已经为真，但沿状态是空的 → 只上膛，不击发
    await put(withTrig('| 好感度 | 9 |'));
    const r1 = (await h({ prompt: 'hi' }, 't', {})).hookSpecificOutput.additionalContext;
    expect(r1, '首轮不该触发（否则每次重启都会重放一遍）').not.toMatch(/主动找你说话/);
    expect(r1, '但要报出挂着几条').toMatch(/触发器：1 条挂着/);

    // ② 落回去，再穿越
    await put(withTrig('| 好感度 | 1 |'));
    await h({ prompt: 'hi' }, 't', {});
    await put(withTrig('| 好感度 | 6 |'));
    const r3 = (await h({ prompt: 'hi' }, 't', {})).hookSpecificOutput.additionalContext;
    expect(r3, '假→真那一轮必须响').toMatch(/她开始主动找你说话了/);
    expect(r3).toMatch(/条件命中/);

    // ③ 一直为真，不再响；once 已退休
    await put(withTrig('| 好感度 | 7 |'));
    const r4 = (await h({ prompt: 'hi' }, 't', {})).hookSpecificOutput.additionalContext;
    expect(r4, '为真不重复触发').not.toMatch(/主动找你说话/);

    resetTurnMemory(sid);
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('⛔ 触发器写错 → 状态块里明说"这条一直不会响"，不静默丢', async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-trig2-'));
    await fs.mkdir(path.join(ws, CHALK_DIR), { recursive: true });
    await fs.writeFile(
      path.join(ws, CHALK_DIR, '20260830-100000-状态.md'),
      renderChalk({
        body: `${T('| a | 1 |')}\n\n\`\`\`nd:triggers\n- [这行没有比较符] once -> x\n\`\`\``,
        by: 'agent', tag: STATE_TABLE_TAG,
      }),
    );
    const sid = `test-trig-bad-${Date.now()}`;
    resetTurnMemory(sid);
    const h = makeUserPromptSubmitHandler({ workspaceRoot: ws, sessionId: sid, projectId: 'proj_trig_test0002' });
    const r = (await h({ prompt: 'hi' }, 't', {})).hookSpecificOutput.additionalContext;
    expect(r).toMatch(/触发器写错了，这条一直不会响/);
    expect(r).toMatch(/没有比较符/);
    resetTurnMemory(sid);
    await fs.rm(ws, { recursive: true, force: true });
  });
});
