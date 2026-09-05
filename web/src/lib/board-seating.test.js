/**
 * 桌面入座算法回归（2026-08-14 B 刀抽出时补的钉子）。
 * 语义背书都在 board-seating.js 的头注释里；这里钉行为。
 */
import { describe, it, expect } from 'vitest';
import { computeDesktopSeating } from './board-seating.js';
import { sizeOf } from './board-kinds.js';

const folderCardOf = (id, pos) => ({
  id, kind: 'folder', x: pos?.x ?? 0, y: pos?.y ?? 0, w: 288, h: 240,
  title: id, count: 0, peek: [],
});

const dirIndexOf = (rootItems, rootFolders = []) => ({
  subsOf: new Map([['', rootFolders]]),
  byDir: new Map([['', rootItems]]),
});

const seat = (over = {}) => computeDesktopSeating({
  dirIndex: dirIndexOf([]),
  zonesEff: {}, layout: {}, bindings: {}, lineageOpen: new Set(),
  boardHero: null, folderCardOf, movingIds: new Set(), claimSeat: null,
  ...over,
});

describe('computeDesktopSeating', () => {
  it('已摆放的永不重排；新来的落到内容底边之下（唯一一条自动）', () => {
    const r = seat({
      dirIndex: dirIndexOf([
        { id: 'a.png', type: 'image' },
        { id: 'b.png', type: 'image' },
      ]),
      layout: { 'a.png': { x: 500, y: 40, z: 1 } },
    });
    const a = r.positioned.find(o => o.id === 'a.png');
    const b = r.positioned.find(o => o.id === 'b.png');
    expect(a.pos).toMatchObject({ x: 500, y: 40 });          // 摆过的不动
    expect(b.pos.y).toBeGreaterThan(40 + sizeOf(a).h - 1);   // 新来的在它底下
    expect(r.seatFixes['b.png']).toBeTruthy();               // 新落点要落盘
    expect(r.seatFixes['a.png']).toBeUndefined();            // 老座位不重写
  });

  it('搬家中且座位已撤的旧 id 不当新客排座（飞进文件夹后不再闪回桌面）', () => {
    const r = seat({
      dirIndex: dirIndexOf([
        { id: 'a.png', type: 'image' },
        { id: 'moving.png', type: 'image' },   // 清单还没刷新，旧 id 仍在根目录
      ]),
      layout: { 'a.png': { x: 40, y: 40, z: 1 } },   // moving.png 的座位已被 useBoardMoves 撤掉
      movingIds: new Set(['moving.png']),
    });
    expect(r.positioned.some(o => o.id === 'moving.png')).toBe(false);   // 不渲染、不排座
    expect(r.seatFixes['moving.png']).toBeUndefined();                    // 更不落盘
    // 对照：同样没座位但不在搬家名单里 → 照旧当新客排座
    const r2 = seat({
      dirIndex: dirIndexOf([{ id: 'a.png', type: 'image' }, { id: 'moving.png', type: 'image' }]),
      layout: { 'a.png': { x: 40, y: 40, z: 1 } },
    });
    expect(r2.positioned.some(o => o.id === 'moving.png')).toBe(true);
  });

  it('起排线也吃文件夹卡的底边', () => {
    const r = seat({
      dirIndex: dirIndexOf([{ id: 'x.png', type: 'image' }], ['素材']),
      zonesEff: { '素材': { x: 10, y: 300 } },
    });
    expect(r.folderView).toHaveLength(1);
    expect(r.positioned[0].pos.y).toBeGreaterThan(300 + 240 - 1);
  });

  it('生图幻影占的地方算已有内容：新卡排到它底下，不叠在一起', () => {
    // issue #1 第 9 条：幻影出生时躲开了所有真卡，可没人躲它，而两边的起排线
    // 是同一条 —— 不把它算进去，等图期间落的新卡必然压在加载动画上。
    const phantom = { x: 40, y: 600, w: 244, h: 210 };
    const r = seat({
      dirIndex: dirIndexOf([{ id: 'new.png', type: 'image' }]),
      occupied: [phantom],
    });
    expect(r.positioned[0].pos.y).toBeGreaterThan(phantom.y + phantom.h - 1);
  });

  it('没有幻影时起排线不受影响（occupied 缺省不改行为）', () => {
    const withNone = seat({ dirIndex: dirIndexOf([{ id: 'n.png', type: 'image' }]) });
    const withEmpty = seat({ dirIndex: dirIndexOf([{ id: 'n.png', type: 'image' }]), occupied: [] });
    expect(withEmpty.positioned[0].pos).toEqual(withNone.positioned[0].pos);
  });

  it('显式主角（board.hero）压过推断并标 tier', () => {
    const r = seat({
      dirIndex: dirIndexOf([
        { id: 'deck:a.html', type: 'deck' },
        { id: 'deck:b.html', type: 'deck' },
      ]),
      boardHero: 'deck:b.html',
    });
    expect(r.positioned.find(o => o.id === 'deck:b.html').tier).toBe('hero');
    expect(r.positioned.find(o => o.id === 'deck:a.html').tier).toBeUndefined();
  });

  it('谱系收叠：改自链旧版隐藏、链尾带纸叠计数；点开则全员在场', () => {
    const items = [
      { id: 'deck:v1.html', type: 'deck' },
      { id: 'deck:v2.html', type: 'deck' },
    ];
    const bindings = { b1: { type: 'derives-from', from: 'deck:v2.html', to: 'deck:v1.html' } };
    const folded = seat({ dirIndex: dirIndexOf(items), bindings });
    expect(folded.positioned.map(o => o.id)).toEqual(['deck:v2.html']);
    expect(folded.positioned[0].stackCount).toBe(1);
    const open = seat({ dirIndex: dirIndexOf(items), bindings, lineageOpen: new Set(['deck:v2.html']) });
    expect(open.positioned).toHaveLength(2);
  });

  it('幻影座位过户：claimSeat 命中的图坐幻影的位置并落盘', () => {
    const r = seat({
      dirIndex: dirIndexOf([{ id: 'assets/generated/n.webp', type: 'image', }]),
      claimSeat: (id) => (id === 'assets/generated/n.webp' ? { x: 777, y: 888 } : null),
    });
    expect(r.positioned[0].pos).toMatchObject({ x: 777, y: 888 });
    expect(r.seatFixes['assets/generated/n.webp']).toMatchObject({ x: 777, y: 888 });
  });

  it('搬家中的 id 不落盘（落了=指向死路径的幽灵行）', () => {
    const r = seat({
      dirIndex: dirIndexOf([{ id: 'ghost.png', type: 'image' }]),
      movingIds: new Set(['ghost.png']),
    });
    expect(r.seatFixes['ghost.png']).toBeUndefined();
  });

  it('批注手写字跟随目标：落到首目标那一行的右端空白', () => {
    const r = seat({
      dirIndex: dirIndexOf([{ id: 'deck:主稿.html', type: 'deck' }]),
      layout: { 'text:t1': { kind: 'text', x: 5, y: 5, w: 160 } },
      bindings: { b1: { type: 'annotates', from: 'text:t1', to: 'deck:主稿.html' } },
    });
    const slot = r.positioned.find(o => o.id === 'deck:主稿.html');
    expect(r.noteFixes['text:t1'].y).toBe(Math.round(slot.pos.y));
    expect(r.noteFixes['text:t1'].x).toBeGreaterThan(slot.pos.x);
  });
});

describe('暂存架模式（2026-08-30）', () => {
  it('⭐ board.shelf 给了 → 新客码进架带（seat:shelf 随 fix 落盘），不再在内容底下另起一行', () => {
    const r = seat({
      dirIndex: dirIndexOf([{ id: 'new.png', type: 'image' }, { id: 'old.png', type: 'image' }]),
      layout: { 'old.png': { x: -360, y: 100, z: 1, w: 200, h: 176, seat: 'shelf' } },
      shelf: { x: -360, y: 24 },
    });
    const fix = r.seatFixes['new.png'];
    expect(fix.seat).toBe('shelf');
    expect(fix.x).toBe(-360);
    expect(fix.y).toBeGreaterThanOrEqual(100 + 176 + 24);   // 码在架上已有那件下面
  });

  it('没有架（还没立过）→ 走老 packRow 兜底，fix 不带 seat', () => {
    const r = seat({ dirIndex: dirIndexOf([{ id: 'n.png', type: 'image' }]) });
    expect(r.seatFixes['n.png'].seat).toBeUndefined();
  });
});

describe('临时座与尺寸回写（2026-09-05：服务端求解器为准）', () => {
  it('⭐ 新客的座标 provisional（packRow 不认障碍，服务端会重解）；架上的座不标', () => {
    const r = seat({ dirIndex: dirIndexOf([{ id: 'n.png', type: 'image' }]) });
    expect(r.seatFixes['n.png'].provisional).toBe(true);
  });
  it('⭐ 产物卡把渲染尺寸回写（主角 1.5 倍那份服务端估不准）；存的一致就不写；图片不管', () => {
    const items = [{ id: 'site:x', type: 'site' }, { id: 'deck:y', type: 'deck' }, { id: 'p.png', type: 'image' }];
    const layout = { 'site:x': { x: 0, y: 0 }, 'deck:y': { x: 0, y: 900, w: 640, h: 388 }, 'p.png': { x: 0, y: 2000 } };
    const r = seat({ dirIndex: dirIndexOf(items), layout, boardHero: 'site:x' });
    const hero = r.positioned.find(it => it.id === 'site:x');
    expect(hero.tier).toBe('hero');
    expect(r.sizeFixes['site:x']).toEqual(sizeOf(hero));       // 主角尺寸回写
    expect(r.sizeFixes['site:x'].w).toBeGreaterThan(640);
    expect(r.sizeFixes['deck:y']).toBeUndefined();              // 存的跟渲染一致，不写
    expect(r.sizeFixes['p.png']).toBeUndefined();               // 图片不回写
  });
});
