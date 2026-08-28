/**
 * roll_dice 测试 —— 钉「骰子是真投的、结果两条路都走」。
 * RNG 注入假骰（rngInt），断言算术/优劣势/判定/暴击话术与 run.dice 事件形状。
 */
import { describe, it, expect } from 'vitest';
import { makeRollDiceTool, describeRoll } from './roll-dice.js';

const P = 'proj_dice_test0';
const mk = (faces, events = []) => {
  let i = 0;
  return makeRollDiceTool({
    projectId: P,
    ctx: { emit: (e) => events.push(e) },
    rngInt: () => faces[i++ % faces.length],
  });
};

describe('roll_dice', () => {
  it('d20+3 过 DC：成功、事件带完整骰面', async () => {
    const events = [];
    const t = mk([14], events);
    const r = await t.handler({ label: '斥候·侦查', modifier: 3, dc: 15 }, {});
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain('= **17**');
    expect(r.content[0].text).toContain('**成功**');
    expect(events[0]).toMatchObject({ type: 'run.dice', label: '斥候·侦查', rolls: [14], total: 17, dc: 15, outcome: 'success' });
  });

  it('优势取高 / 劣势取低；n>1 配 advantage 拒收', async () => {
    const adv = await mk([6, 17]).handler({ label: 'x', advantage: 'adv' }, {});
    expect(adv.content[0].text).toContain('= **17**');
    const dis = await mk([6, 17]).handler({ label: 'x', advantage: 'dis' }, {});
    expect(dis.content[0].text).toContain('= **6**');
    const bad = await mk([1]).handler({ label: 'x', advantage: 'adv', n: 2 }, {});
    expect(bad.isError).toBe(true);
  });

  it('多骰求和；自然 20 / 自然 1 有镜头提示（仅单 d20）', async () => {
    const sum = await mk([3, 5]).handler({ label: '伤害', sides: 6, n: 2, modifier: 1 }, {});
    expect(sum.content[0].text).toContain('= **9**');
    expect(sum.content[0].text).not.toContain('自然');
    const crit = await mk([20]).handler({ label: '致命一击' }, {});
    expect(crit.content[0].text).toContain('自然 20');
    const fumble = await mk([1]).handler({ label: '滑手' }, {});
    expect(fumble.content[0].text).toContain('自然 1');
  });

  it('describeRoll：无 DC 不判成败', () => {
    const line = describeRoll({ label: 'x', n: 1, sides: 20, modifier: 0, advantage: 'none', rolls: [7], kept: 7, total: 7, dc: null });
    expect(line).not.toContain('成功');
    expect(line).not.toContain('失败');
  });
});
