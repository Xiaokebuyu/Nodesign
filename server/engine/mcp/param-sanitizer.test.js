/**
 * 参数标签泄漏消毒钉子（2026-08-19）。
 *
 * 事故原文（会话 008fe16c，claude-opus-5-5[1m]，jsonl 里 tool_use.input 原样）：
 * rationale 值尾部是 `…</rationale>\n<parameter name="scope">庄家（对手）`，
 * scope 键缺失。正反都钉：真泄漏要拆回来、判据不全的一律不动。
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { splitLeakedParams, desmearArgs, withParamSanitizer } from './param-sanitizer.js';

const SHAPE = {
  title: z.string(),
  rationale: z.string(),
  scope: z.string().optional(),
  alternatives: z.array(z.string()).optional(),
};

const ctx = (present = ['title', 'rationale']) => ({
  stringKeys: new Set(['title', 'rationale', 'scope']),
  presentKeys: new Set(present),
});

describe('splitLeakedParams', () => {
  it('事故原样：rationale 吞了 scope → 拆回', () => {
    const v = '形象不照搬原作。</rationale>\n<parameter name="scope">庄家（对手）';
    const hit = splitLeakedParams('rationale', v, ctx());
    expect(hit).toEqual({ clean: '形象不照搬原作。', recovered: { scope: '庄家（对手）' } });
  });

  it('段尾挂着闭合标签也剥掉', () => {
    const v = '正文。</rationale>\n<parameter name="scope">全部音效</scope>\n';
    const hit = splitLeakedParams('rationale', v, ctx());
    expect(hit.recovered.scope).toBe('全部音效');
  });

  it('链式泄漏：一个值连吞两个参数', () => {
    const v = 't</title>\n<parameter name="rationale">理由</rationale>\n<parameter name="scope">范围';
    const hit = splitLeakedParams('title', v, { stringKeys: new Set(['title', 'rationale', 'scope']), presentKeys: new Set(['title']) });
    expect(hit).toEqual({ clean: 't', recovered: { rationale: '理由', scope: '范围' } });
  });

  it('判据不全一律不动：目标参数不在 schema / 已在场 / 闭合标签名对不上', () => {
    const c = ctx();
    expect(splitLeakedParams('rationale', 'x</rationale>\n<parameter name="nope">y', c)).toBeNull();
    expect(splitLeakedParams('rationale', 'x</rationale>\n<parameter name="title">y', c)).toBeNull();
    expect(splitLeakedParams('rationale', 'x</scope>\n<parameter name="scope">y', c)).toBeNull();
    // 正文里合法讨论 XML 不受影响
    expect(splitLeakedParams('rationale', '用 <parameter name="x"> 这种语法', c)).toBeNull();
  });
});

describe('desmearArgs', () => {
  it('没泄漏原对象原样返回（同一引用）', () => {
    const args = { title: 't', rationale: '干净正文' };
    const { args: out, leaks } = desmearArgs(args, SHAPE);
    expect(out).toBe(args);
    expect(leaks).toEqual([]);
  });

  it('泄漏时拆回 + 上报清单；数组参数不当恢复目标', () => {
    const args = {
      title: 't',
      rationale: '理由。</rationale>\n<parameter name="scope">整个游戏画面',
      alternatives: ['a', 'b'],
    };
    const { args: out, leaks } = desmearArgs(args, SHAPE);
    expect(out.rationale).toBe('理由。');
    expect(out.scope).toBe('整个游戏画面');
    expect(out.alternatives).toEqual(['a', 'b']);
    expect(leaks).toEqual([{ from: 'rationale', recovered: ['scope'] }]);
  });
});

describe('withParamSanitizer（包真 tool() 定义）', () => {
  it('handler 收到的是拆回后的 args；干净调用零感知', async () => {
    let seen = null;
    const def = tool('demo', 'd', SHAPE, async (args) => { seen = args; return { content: [] }; });
    withParamSanitizer(def, { projectId: 'p_test', sessionId: 's_test' });

    await def.handler({ title: 't', rationale: '理由。</rationale>\n<parameter name="scope">范围' }, {});
    expect(seen.rationale).toBe('理由。');
    expect(seen.scope).toBe('范围');

    const clean = { title: 't', rationale: 'ok' };
    await def.handler(clean, {});
    expect(seen).toBe(clean);
  });
});
