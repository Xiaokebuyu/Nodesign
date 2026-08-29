/**
 * browser_batch 的合同：串行、遇错即停、halt 文案逐字、结尾补截图、名字/入参把关。
 * 用假工具定义跑（handler 是 spy），不起浏览器。
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { makeBrowserBatchTool, makeBatchTool, HALT_TEXT, BATCHABLE } from './browse-find-batch.js';
import { formatMatches, staleRefText } from '../../browse/refs.js';

const fake = (name, shape, impl) => ({ name, description: name, inputSchema: shape, handler: impl });
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

function rig() {
  const log = [];
  const tools = [
    fake('browser_computer', { action: z.string(), text: z.string().optional() },
      async (a) => { log.push(`computer:${a.action}`); return a.action === 'boom' ? text('Error: boom', true) : text(`did ${a.action}`); }),
    fake('browser_find', { query: z.string().min(1) }, async (a) => { log.push(`find:${a.query}`); return text('found ref_1'); }),
    fake('browser_screenshot', {}, async () => { log.push('shot'); return { content: [{ type: 'text', text: 'shot' }, { type: 'image', data: 'x', mimeType: 'image/webp' }] }; }),
    fake('browser_request_help', { reason: z.string() }, async () => { log.push('help'); return text('helped'); }),   // 不在 BATCHABLE 里
  ];
  return { log, batch: makeBrowserBatchTool({ tools }) };
}

describe('browser_batch', () => {
  it('合同常量：halt 文案逐字；capture 可 batch（逐页采 token）、request_help 不可（阻塞等人）', () => {
    expect(HALT_TEXT).toBe('Not executed: an earlier action in this turn failed.');
    expect(BATCHABLE).toContain('browser_capture');
    expect(BATCHABLE).not.toContain('browser_request_help');
    expect(BATCHABLE).not.toContain('browser_batch');
  });

  // ── 放错层的参数（2026-08-29 真会话案 proj_mtdr2xpa）────────────────────
  it('⭐ 写在 action 层的工具参数被收进 input，并如实报一句', async () => {
    const { log, batch } = rig();
    const r = await batch.handler({ actions: [
      { name: 'browser_computer', action: 'left_click' },              // 整个 input 都写在外面
      { name: 'browser_computer', input: { action: 'type' }, text: 'hi' },   // 半个写在外面
    ] }, {});
    expect(log).toEqual(['computer:left_click', 'computer:type', 'shot']);
    const all = r.content.map(c => c.text || '').join('\n');
    expect(all).toMatch(/action 本该写在 input 里/);
    expect(all).toMatch(/text 本该写在 input 里/);
  });

  it('action 层的 screenshotAfter 抬到整批（不是当垃圾丢掉）', async () => {
    const tools = [fake('browser_find', { query: z.string() }, async () => text('found'))];
    const b = makeBatchTool({
      name: 'b', description: 'd', tools, batchable: ['browser_find', 'browser_screenshot'],
      finalShot: { name: 'browser_screenshot', input: {}, default: false },
    });
    const r = await b.handler({ actions: [{ name: 'browser_find', input: { query: 'q' }, screenshotAfter: true }] }, {});
    expect(r.content.map(c => c.text || '').join('\n')).toMatch(/screenshotAfter 是整批的旋钮/);
  });

  it('不认识的键忽略掉但要说出来（别让模型以为它生效了）', async () => {
    const { batch } = rig();
    const r = await batch.handler({ actions: [{ name: 'browser_find', input: { query: 'q' }, 火星参数: 1 }] }, {});
    expect(r.content.map(c => c.text || '').join('\n')).toMatch(/火星参数 不是 browser_find 的参数/);
  });

  it('串行按序跑，结尾补一张截图', async () => {
    const { log, batch } = rig();
    const r = await batch.handler({ actions: [
      { name: 'browser_find', input: { query: 'search' } },
      { name: 'browser_computer', input: { action: 'left_click' } },
      { name: 'browser_computer', input: { action: 'type', text: 'hi' } },
    ] }, {});
    expect(log).toEqual(['find:search', 'computer:left_click', 'computer:type', 'shot']);
    expect(r.isError).toBeUndefined();
    const texts = r.content.filter(b => b.type === 'text').map(b => b.text);
    expect(texts[0]).toBe('[1/3] browser_find: found ref_1');
    expect(texts[1]).toBe('[2/3] browser_computer left_click: did left_click');
    expect(texts.at(-2)).toMatch(/^\[after\] current state/);
    expect(r.content.filter(b => b.type === 'image')).toHaveLength(1);
  });

  it('遇错即停：失败项报错，后面的全部 halt 文案，整体 isError，仍补截图供重规划', async () => {
    const { log, batch } = rig();
    const r = await batch.handler({ actions: [
      { name: 'browser_computer', input: { action: 'left_click' } },
      { name: 'browser_computer', input: { action: 'boom' } },
      { name: 'browser_computer', input: { action: 'type', text: 'never' } },
      { name: 'browser_find', input: { query: 'never' } },
    ] }, {});
    expect(log).toEqual(['computer:left_click', 'computer:boom', 'shot']);
    expect(r.isError).toBe(true);
    const texts = r.content.filter(b => b.type === 'text').map(b => b.text);
    // 头块 = 失败摘要（08-24：错误必须排最前 —— 记账层截前 120/500 字符、
    // 模型扫返回，都先看到真报错而不是成功步骤的输出）+ 别整批重跑的钉子
    expect(texts[0]).toMatch(/^FAILED at step 2\/4 \(browser_computer boom\): Error: boom/);
    expect(texts[0]).toMatch(/do NOT re-run the whole batch/);
    expect(texts[1]).toBe('[1/4] browser_computer left_click: did left_click');
    expect(texts[2]).toBe('[2/4] browser_computer boom: Error: boom');
    expect(texts[3]).toBe(`[3/4] browser_computer type: ${HALT_TEXT}`);
    expect(texts[4]).toBe(`[4/4] browser_find: ${HALT_TEXT}`);
    expect(texts[5]).toMatch(/stopped early/);
  });

  it('最后一项已出图就不再补；screenshotAfter:false 也不补', async () => {
    const a = rig();
    await a.batch.handler({ actions: [{ name: 'browser_screenshot', input: {} }] }, {});
    expect(a.log).toEqual(['shot']);
    const b = rig();
    await b.batch.handler({ actions: [{ name: 'browser_find', input: { query: 'x' } }], screenshotAfter: false }, {});
    expect(b.log).toEqual(['find:x']);
  });

  it('不可 batch 的名字 / 不合 schema 的入参 → 当条报错并停', async () => {
    const { log, batch } = rig();
    const r = await batch.handler({ actions: [
      { name: 'browser_request_help', input: { reason: 'x' } },
      { name: 'browser_find', input: { query: 'x' } },
    ] }, {});
    expect(log).toEqual(['shot']);
    expect(r.content[0].text).toMatch(/^FAILED at step 1\/2 .*not batchable/s);
    expect(r.content[1].text).toMatch(/not batchable/);
    expect(r.content[2].text).toBe(`[2/2] browser_find: ${HALT_TEXT}`);

    const s = rig();
    const r2 = await s.batch.handler({ actions: [{ name: 'browser_find', input: { query: '' } }] }, {});
    expect(s.log).toEqual(['shot']);
    expect(r2.content[0].text).toMatch(/^FAILED at step 1\/1 .*invalid input — query/s);
    expect(r2.content[1].text).toMatch(/invalid input — query/);
  });
});

describe('refs 文本', () => {
  it('stale 错误是可执行的一句话', () => {
    expect(staleRefText('ref_3')).toMatch(/ref_3 is stale.*browser_find again/);
  });
  it('formatMatches：空结果给下一步，非空带 ref/角色/坐标', () => {
    expect(formatMatches({ matches: [], candidates: 12 }, 'buy').join('\n')).toMatch(/没找到.*12 个/);
    const lines = formatMatches({ candidates: 3, matches: [
      { ref: 'ref_1', role: 'button', name: '接受全部', x: 640, y: 700, w: 120, h: 40, inView: true, href: '' },
      { ref: 'ref_2', role: 'link', name: 'Pricing', x: 300, y: 1200, w: 60, h: 20, inView: false, href: 'https://x.test/pricing' },
    ] }, '接受');
    expect(lines[1]).toContain('ref_1  button  「接受全部」 120×40 @(640,700)');
    expect(lines[2]).toMatch(/ref_2  link.*视口外↓.*→ https:\/\/x\.test\/pricing/);
  });
});

describe('batch 重置（2026-08-27）：resolve 运行时解析 + 诚实的 screenshotAfter', () => {
  it('⭐ resolve 传了就用注册表里（包装后）的实例 —— 能力闸/消毒对 batch 内调用生效', async () => {
    const wrapped = new Map();
    const calls = [];
    wrapped.set('a', fake('a', { v: z.string().optional() }, async () => { calls.push('wrapped'); return text('ok'); }));
    const batch = makeBatchTool({ name: 't', description: 't', batchable: ['a'], resolve: (n) => wrapped.get(n) });
    const r = await batch.handler({ actions: [{ name: 'a', input: {} }] }, {});
    expect(calls).toEqual(['wrapped']);
    expect(r.isError).toBeUndefined();
  });

  it('政策名单里有、注册表里没有 = 被能力/模式闸下架 → 如实报，不说「不可 batch」', async () => {
    const batch = makeBatchTool({
      name: 't', description: 't', batchable: ['a', 'gone'],
      resolve: (n) => (n === 'a' ? fake('a', {}, async () => text('ok')) : undefined),
    });
    const r = await batch.handler({ actions: [{ name: 'gone', input: {} }] }, {});
    expect(r.isError).toBe(true);
    expect(r.content.filter(b => b.type === 'text').map(b => b.text).join('\n')).toMatch(/下架/);
  });

  it('⭐ 没有 finalShot 就没有 screenshotAfter 参数（不给模型永远无效的旋钮）', () => {
    const a = () => fake('a', {}, async () => text('ok'));
    const withShot = makeBatchTool({ name: 't', description: 't', batchable: ['a'], tools: [a()], finalShot: { name: 'a', input: {} } });
    const without = makeBatchTool({ name: 't', description: 't', batchable: ['a'], tools: [a()] });
    expect(Object.keys(withShot.inputSchema)).toContain('screenshotAfter');
    expect(Object.keys(without.inputSchema)).not.toContain('screenshotAfter');
  });

  it('finalShot.default:false（board_batch 档）：缺省不补图，传 true 才补', async () => {
    const log = [];
    const tools = [
      fake('w', {}, async () => { log.push('w'); return text('ok'); }),
      fake('look', {}, async () => { log.push('look'); return { content: [{ type: 'image', data: 'x', mimeType: 'image/webp' }] }; }),
    ];
    const batch = makeBatchTool({ name: 't', description: 't', batchable: ['w', 'look'], tools, finalShot: { name: 'look', input: {}, default: false } });
    await batch.handler({ actions: [{ name: 'w', input: {} }] }, {});
    expect(log).toEqual(['w']);
    await batch.handler({ actions: [{ name: 'w', input: {} }], screenshotAfter: true }, {});
    expect(log).toEqual(['w', 'w', 'look']);
  });
});
