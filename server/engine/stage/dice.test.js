import { describe, it, expect } from 'vitest';
import { rollCheck, normalizeCheck, diceText } from './dice.js';

/** 判定骰：注入 rng 让点数可控，验成败 / 大成功大失败 / 优势劣势 / 修正 / 一行人话 */
const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };

describe('判定骰', () => {
  it('normalizeCheck：缺省 d20 一颗；越界收边；优势时颗数收成 1；dc 可空', () => {
    expect(normalizeCheck({})).toMatchObject({ sides: 20, count: 1, modifier: 0, advantage: 'none', dc: null, reason: '判定' });
    expect(normalizeCheck({ sides: 5000, count: 99, modifier: 999, dc: 0, label: '翻墙' })).toMatchObject({ sides: 1000, count: 10, modifier: 100, dc: 1, reason: '翻墙' });
    expect(normalizeCheck({ advantage: 'adv', count: 3 }).count).toBe(1);
    expect(normalizeCheck({ advantage: 'weird' }).advantage).toBe('none');
  });
  it('成败按 总点 + 修正 vs dc；没 dc 就只是掷个数', () => {
    expect(rollCheck({ dc: 12, modifier: 2 }, seq(10)).outcome).toBe('success');   // 10 + 2 = 12 ≥ 12
    expect(rollCheck({ dc: 13, modifier: 2 }, seq(10)).outcome).toBe('fail');
    expect(rollCheck({}, seq(10)).outcome).toBeNull();
    expect(rollCheck({ sides: 6, count: 3, dc: 10 }, seq(4, 5, 6))).toMatchObject({ rolls: [4, 5, 6], total: 15, outcome: 'success' });
  });
  it('大成功 / 大失败只看单颗 ≥ d20 的天然点数，修正救不回', () => {
    expect(rollCheck({ dc: 30, modifier: -5 }, seq(20)).outcome).toBe('crit');
    expect(rollCheck({ dc: 2, modifier: 50 }, seq(1)).outcome).toBe('fumble');
    expect(rollCheck({ sides: 6, dc: 3 }, seq(6)).outcome).toBe('success');   // d6 没有大成功
    expect(rollCheck({ sides: 20, count: 2, dc: 3 }, seq(20, 20)).outcome).toBe('success');   // 两颗不算
  });
  it('优势取高、劣势取低，两颗都记在 rolls 里', () => {
    const a = rollCheck({ advantage: 'adv', dc: 15 }, seq(7, 16));
    expect(a).toMatchObject({ rolls: [7, 16], kept: [16], total: 16, outcome: 'success' });
    const d = rollCheck({ advantage: 'dis', dc: 15 }, seq(7, 16));
    expect(d).toMatchObject({ kept: [7], total: 7, outcome: 'fail' });
  });
  it('一行人话', () => {
    expect(diceText(rollCheck({ reason: '翻墙', dc: 12, modifier: 2 }, seq(10)))).toBe('翻墙：d20 +2 = 10 +2 = 12 vs 难度 12 → 成功');
    expect(diceText(rollCheck({ reason: '运气', sides: 6, count: 2 }, seq(3, 4)))).toBe('运气：d6×2 = [3, 4] = 7');
    expect(diceText(rollCheck({ reason: '偷听', advantage: 'adv' }, seq(2, 9)))).toBe('偷听：d20（优势） = [2, 9] = 9');
  });
});

describe('玩家点了带判定的选项：机器代掷', () => {
  it('落一行 dice、推给显示器、便条写明成败；没 check 就什么都不做', async () => {
    const { rollForChoice } = await import('./mechanics.js');
    const fs = await import('node:fs/promises'); const os = await import('node:os'); const path = await import('node:path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-dice-'));
    const sent = [];
    const rt = { playAbs: dir, scenesRel: '场景/scenes.jsonl', broadcast: (e) => sent.push(e) };
    expect(await rollForChoice(rt, null)).toBe('');
    const note = await rollForChoice(rt, { label: '翻墙', dc: 1 });
    expect(note).toMatch(/^【判定】.*翻墙：d20 = \d+ vs 难度 1 → (成功|大成功)。照这个结果写/);
    expect(sent[0].type).toBe('scene'); expect(sent[0].row.by).toBe('dice'); expect(sent[0].row.reason).toBe('翻墙');
    const lines = (await fs.readFile(path.join(dir, '场景/scenes.jsonl'), 'utf8')).trim().split('\n');
    expect(JSON.parse(lines[0])).toMatchObject({ by: 'dice', dc: 1, sides: 20 });
    await fs.rm(dir, { recursive: true, force: true });
  });
});
