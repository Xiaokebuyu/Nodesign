import { describe, it, expect } from 'vitest';
import { sheetMembers, membersInRect, nextSpotInSheet, sheetOfPoint, isInk } from './board-sheets.js';
import { obstaclesIn } from './board-obstacles.js';

/**
 * 叠纸刀 1 的回归钉（2026-09-01）。
 *
 * 病根复刻：两张纸占**同一块地**。在这之前成员归属纯按中心点判，于是在第二页
 * 写第一笔时，第一页的全部内容都会被算成障碍 —— 版位报"剩 0 行"，第一发就被拒。
 * 判据只有一条：`objects[id].sheet` 认领了哪一页。
 */
const stacked = () => ({
  sheets: {
    p1: {
      x: 0, y: 0, w: 1000, h: 800, at: '2026-09-01T01:00:00Z', stack: 'main', colW: 432,
    },
    p2: {
      x: 0, y: 0, w: 1000, h: 800, at: '2026-09-01T02:00:00Z', stack: 'main', colW: 432,
    },
  },
  stacks: { main: { at: '2026-09-01T01:00:00Z' } },
  zones: {},
  objects: {
    // 第一页写满了大半块地
    'notes/板书/a.md': { x: 24, y: 24, w: 400, h: 500, sheet: 'p1' },
    // 用户拖进来的散件：没认领任何一页
    'assets/loose.png': { x: 600, y: 24, w: 200, h: 200 },
  },
});

describe('叠纸：一摞纸共用一块地，成员归属靠认领消歧', () => {
  it('⭐ 第一页的板书不算第二页的成员', () => {
    const b = stacked();
    expect(sheetMembers(b, 'p1').map(m => m.id)).toContain('notes/板书/a.md');
    expect(sheetMembers(b, 'p2').map(m => m.id)).not.toContain('notes/板书/a.md');
  });

  it('⭐ 没认领任何一页的散件算每一页的成员（它不参与叠放，一直画在那儿）', () => {
    const b = stacked();
    expect(sheetMembers(b, 'p1').map(m => m.id)).toContain('assets/loose.png');
    expect(sheetMembers(b, 'p2').map(m => m.id)).toContain('assets/loose.png');
  });

  it('⭐ 几何仍然是闸：认领了 p1 但被拖出纸外的，不再是 p1 的成员', () => {
    const b = stacked();
    b.objects['notes/板书/a.md'].x = 5000;      // 用户把它拖到纸外边去了
    expect(sheetMembers(b, 'p1').map(m => m.id)).not.toContain('notes/板书/a.md');
  });

  it('⭐ 栏内余量按页算：第二页的第一栏是空的，第一页那一栏已经写到 524', () => {
    const b = stacked();
    const box = { w: 400, h: 200 };
    // 第一页：500 高的板书占着第一栏 → 接在它下面
    expect(nextSpotInSheet(b, 'p1', box).y).toBe(24 + 500 + 24);
    // 第二页：同一块地，第一栏是空的 —— 不消歧的话这里会跟第一页拿到同一个数
    expect(nextSpotInSheet(b, 'p2', box).y).toBe(24);
  });

  it('membersInRect 不传 sheetId 时退回老口径（存量不叠的板行为不变）', () => {
    const b = stacked();
    expect(membersInRect(b, { x: 0, y: 0, w: 1000, h: 800 }).map(m => m.id))
      .toContain('notes/板书/a.md');
    expect(membersInRect(b, { x: 0, y: 0, w: 1000, h: 800 }, 'p2').map(m => m.id))
      .not.toContain('notes/板书/a.md');
  });

  it('⭐ 障碍集按页分：在第二页上放东西，第一页的墨不挡路', () => {
    const b = stacked();
    const onP1 = obstaclesIn(b, '', { sheetId: 'p1' }).map(o => o.id);
    const onP2 = obstaclesIn(b, '', { sheetId: 'p2' }).map(o => o.id);
    expect(onP1).toContain('notes/板书/a.md');
    expect(onP2).not.toContain('notes/板书/a.md');
    // 没认领任何一页的散件两页都挡（它一直画在屏幕上）
    expect(onP1).toContain('assets/loose.png');
    expect(onP2).toContain('assets/loose.png');
    // 不传 sheetId = 全算（存量不叠的板行为不变）
    expect(obstaclesIn(b, '').map(o => o.id)).toContain('notes/板书/a.md');
  });

  it('⭐ 只有墨会认领页：产物 / 站点卡 / 文件夹卡一页都不认', () => {
    // 墨：板书本体、手写字、涂鸦
    expect(isInk('notes/板书/20260901-一.md', {})).toBe(true);
    expect(isInk('text:abc', { kind: 'text' })).toBe(true);
    expect(isInk('scribble:abc', { kind: 'scribble' })).toBe(true);
    // 不是墨：产物、站点、文档、文件夹、随便一个 md
    for (const [id, e] of [
      ['assets/图.png', {}], ['site:我的站', {}], ['deck:主稿.html', {}],
      ['素材', {}], ['预设/体例.md', {}], ['notes/便签/a.md', {}],
    ]) expect(isInk(id, e), id).toBe(false);
  });

  it('⭐ 点落在哪张纸：它自己认领的那一页优先，几何只是兜底', () => {
    const b = stacked();
    const pt = { x: 100, y: 100 };
    // 不说自己是谁：几何取登记时间最新的那张（一摞的顶上）
    expect(sheetOfPoint(b, pt).id).toBe('p2');
    // 说了就认它的
    expect(sheetOfPoint(b, pt, 'p1').id).toBe('p1');
    // 说了一张不存在的、或者压根没盖住这个点的，退回几何
    expect(sheetOfPoint(b, pt, 'nope').id).toBe('p2');
  });
});
