/**
 * 让路（09-17）：agent 说了位置就按那个位置落，挡路的让开。
 * 判据先验：每条都给它一个**必须挪动的东西**，再配一条反向的（不挡路就别动人家）。
 */
import { describe, it, expect } from 'vitest';
import { planYield, describeYield } from './board-yield.js';

const r = (id, x, y, w = 200, h = 100, extra = {}) => ({ id, x, y, w, h, ...extra });

describe('planYield', () => {
  it('没人挡就不动任何东西', () => {
    const out = planYield(r('新', 0, 0), [r('远', 900, 900)]);
    expect(out).toMatchObject({ ok: true, moves: [] });
  });

  it('⭐ 挡路的按位移最小的方向让开，让到不重叠再加一个间距', () => {
    // 新件落在 (0,0,200x100)，旧件左上角压在 (150,0)：往右让 74 比往下让 124 近
    const out = planYield(r('新', 0, 0), [r('旧', 150, 0)]);
    expect(out.ok).toBe(true);
    expect(out.moves).toHaveLength(1);
    expect(out.moves[0]).toMatchObject({ id: '旧', dy: 0 });
    expect(out.moves[0].dx).toBeGreaterThan(0);
    expect(out.moves[0].x).toBeGreaterThanOrEqual(200);   // 让到新件右边缘之外
  });

  it('⭐ 同一组整组一起让，不拆散', () => {
    const group = [r('a', 150, 0, 200, 100, { tag: 'g' }), r('b', 150, 120, 200, 100, { tag: 'g' })];
    const out = planYield(r('新', 0, 0), group);
    expect(out.ok).toBe(true);
    expect(out.moves.map((m) => m.id).sort()).toEqual(['a', 'b']);
    expect(out.moves[0].dx).toBe(out.moves[1].dx);
  });

  it('⭐ 用户亲手摆过的也让（09-17 试行：先不给特权）', () => {
    const out = planYield(r('新', 0, 0), [r('用户摆的', 150, 0, 200, 100, { seat: 'user' })]);
    expect(out.moves.map((m) => m.id)).toEqual(['用户摆的']);
  });

  it('浮层不让：卷卡 / 生图幻影 / 直播框不占世界坐标', () => {
    const out = planYield(r('新', 0, 0), [r('roll:旧线', 150, 0), r('ph:1', 160, 0), r('live:t1', 170, 0)]);
    expect(out).toMatchObject({ ok: true, moves: [] });
  });

  it('连锁：被让的撞到别人就继续往下传', () => {
    const out = planYield(r('新', 0, 0), [r('一', 150, 0), r('二', 380, 0)]);
    expect(out.ok).toBe(true);
    expect(out.moves.map((m) => m.id).sort()).toEqual(['一', '二']);
  });

  it('⛔ 累计位移超过一屏 → 整件放弃，调用方退回找空位', () => {
    const wall = Array.from({ length: 12 }, (_, i) => r(`w${i}`, 150 + i * 210, 0));
    const out = planYield(r('新', 0, 0, 800, 100), wall);
    expect(out.ok).toBe(false);
    expect(out.moves).toEqual([]);
    expect(out.why).toMatch(/一屏|层/);
  });

  it('exclude 里的不算障碍（主体自己、同组成员）', () => {
    const out = planYield(r('新', 0, 0), [r('自己', 150, 0)], { exclude: new Set(['自己']) });
    expect(out.moves).toEqual([]);
  });

  it('报文点名挪开了谁，超过四件说「等 N 件」', () => {
    expect(describeYield([])).toBe('');
    expect(describeYield([{ id: 'A' }, { id: 'B' }])).toContain('挪开了 A、B');
    expect(describeYield(Array.from({ length: 6 }, (_, i) => ({ id: `x${i}` })))).toContain('等 6 件');
  });
});
