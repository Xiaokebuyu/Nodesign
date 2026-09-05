import { describe, it, expect } from 'vitest';
import { evalTerm, evalCondition, validateCondition, evaluateRules } from './rules.js';

/**
 * 成就与触发的机械层：只做比较，没有 eval。
 * 阈值是主 agent 从酒馆卡翻的、按难度定的；这里只管"到了没到"。
 */
describe('单项比较', () => {
  const S = { 好感: 62, 时间: '放学', 表白状态: 1, 拍数: 30 };
  it('数字按数字比', () => {
    expect(evalTerm('好感 >= 60', S)).toBe(true);
    expect(evalTerm('好感 > 62', S)).toBe(false);
    expect(evalTerm('拍数 <= 30', S)).toBe(true);
    expect(evalTerm('表白状态 == 1', S)).toBe(true);
  });
  it('字串按字串比；全角符号也认', () => {
    expect(evalTerm('时间 == 放学', S)).toBe(true);
    expect(evalTerm('时间 != 早读', S)).toBe(true);
    expect(evalTerm('好感 ≥ 60', S)).toBe(true);
  });
  it('⛔ 键不存在一律为假（没量过的东西不参与判断，不当 0 也不当空串）', () => {
    expect(evalTerm('体力 < 100', S)).toBe(false);
    expect(evalTerm('体力 == ', S)).toBe(false);
  });
  it('数字跟字串比大小不成立', () => {
    expect(evalTerm('时间 > 3', S)).toBe(false);
  });
});

describe('整条条件', () => {
  const S = { 好感: 62, 时间: '放学', 表白状态: 0 };
  it('and 比 or 优先', () => {
    expect(evalCondition('好感 >= 60 and 表白状态 == 1 or 时间 == 放学', S)).toBe(true);
    expect(evalCondition('好感 >= 60 and 表白状态 == 1', S)).toBe(false);
    expect(evalCondition('好感 >= 60 且 时间 == 放学', S)).toBe(true);
    expect(evalCondition('好感 >= 90 || 表白状态 == 1', S)).toBe(false);
  });
  it('validateCondition 抓写错的', () => {
    expect(validateCondition('好感 >= 60')).toBeNull();
    expect(validateCondition('')).toMatch(/空/);
    expect(validateCondition('好感很高')).toMatch(/看不懂/);
    expect(validateCondition('好感 >= 60 and 她笑了')).toMatch(/她笑了/);
  });
});

describe('跑一遍规则', () => {
  const rules = {
    achievements: [
      { id: 'first-smile', title: '她笑了', when: '好感 >= 30', tier: 'bronze' },
      { id: 'confess', title: '说出口', when: '表白状态 == 1', tier: 'gold', hidden: true },
    ],
    triggers: [
      { id: 'phase-2', when: '好感 >= 60', note: '进熟稔期' },
      { id: 'late', when: '时间 == 放学', note: '放学了', once: false },
    ],
  };
  it('新达成的才报；已达成 / 已触发过的一次性触发不再报', () => {
    const seen = { earned: new Set(['first-smile']), fired: new Set(['phase-2']) };
    const r = evaluateRules(rules, { 好感: 70, 表白状态: 1, 时间: '放学' }, seen);
    expect(r.trophies.map(t => t.id)).toEqual(['confess']);
    expect(r.trophies[0].hidden).toBe(true);
    expect(r.notes.map(n => n.id)).toEqual(['late']);   // phase-2 已触发过、late 是每次都递
  });
  it('什么都没到就两手空空', () => {
    const r = evaluateRules(rules, { 好感: 10, 时间: '早读' }, { earned: new Set(), fired: new Set() });
    expect(r.trophies).toEqual([]);
    expect(r.notes).toEqual([]);
  });
});
