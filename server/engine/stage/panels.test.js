import { describe, it, expect } from 'vitest';
import { declarePanels, applyOp, digest } from './panels.js';

/** 面板：清单类状态的机械动作。数量加减、装备同槽互斥、买东西扣钱进背包、摘要一行。 */
describe('面板', () => {
  const decl = declarePanels({}, [
    { id: '背包', name: '背包', kind: 'inventory', items: [{ name: '绳子', qty: 1 }] },
    { id: '装备', name: '装备', kind: 'equipment', who: '不语', slots: ['头', '身', '手'] },
    { id: '杂货铺', name: '杂货铺', kind: 'shop', currency: '金钱', into: '背包', items: [{ name: '苹果', qty: 10, price: 3 }, { name: '火把', price: 5 }] },
  ]);
  it('声明：kind 不认识的归 list；装备有默认槽位；重复声明保留条目', () => {
    const d2 = declarePanels(decl, [{ id: '背包', name: '行囊', kind: 'inventory' }, { id: 'x', kind: 'nope' }]);
    expect(d2['背包'].name).toBe('行囊'); expect(d2['背包'].items[0].name).toBe('绳子');
    expect(d2.x.kind).toBe('list');
    expect(decl['装备'].slots).toEqual(['头', '身', '手']);
  });
  it('add / remove / set 的数量账', () => {
    let r = applyOp(decl, { panel: '背包', op: 'add', item: '苹果', qty: 2 });
    expect(r.change).toBe('背包：+苹果 ×2');
    r = applyOp(r.panels, { panel: '背包', op: 'add', item: '苹果' });
    expect(r.panels['背包'].items.find(x => x.name === '苹果').qty).toBe(3);
    r = applyOp(r.panels, { panel: '背包', op: 'remove', item: '苹果', qty: 1 });
    expect(r.panels['背包'].items.find(x => x.name === '苹果').qty).toBe(2);
    r = applyOp(r.panels, { panel: '背包', op: 'remove', item: '苹果' });
    expect(r.panels['背包'].items.some(x => x.name === '苹果')).toBe(false);
    expect(applyOp(r.panels, { panel: '背包', op: 'remove', item: '没有的' }).error).toMatch(/没有/);
    expect(applyOp(r.panels, { panel: '不存在', op: 'add', item: 'x' }).error).toMatch(/没有叫/);
  });
  it('装备：同槽位互斥', () => {
    let r = applyOp(decl, { panel: '装备', op: 'equip', item: '草帽', slot: '头' });
    r = applyOp(r.panels, { panel: '装备', op: 'equip', item: '铁盔', slot: '头' });
    const eq = r.panels['装备'].items;
    expect(eq.find(x => x.name === '草帽').equipped).toBe(false);
    expect(eq.find(x => x.name === '铁盔').equipped).toBe(true);
    expect(applyOp(r.panels, { panel: '背包', op: 'equip', item: '绳子' }).error).toMatch(/不是装备/);
  });
  it('买：扣钱、库存减、进背包；钱不够报错不动账', () => {
    const r = applyOp(decl, { panel: '杂货铺', op: 'buy', item: '苹果', qty: 2 }, { 金钱: 10 });
    expect(r.stateChange).toEqual({ 金钱: 4 });
    expect(r.panels['背包'].items.find(x => x.name === '苹果').qty).toBe(2);
    expect(r.panels['杂货铺'].items.find(x => x.name === '苹果').qty).toBe(8);
    expect(r.change).toMatch(/买了 苹果 ×2，金钱 10 → 4，进了 背包/);
    const bad = applyOp(decl, { panel: '杂货铺', op: 'buy', item: '火把', qty: 3 }, { 金钱: 10 });
    expect(bad.error).toMatch(/只有 10/);
    expect(bad.panels).toBe(decl);
    expect(applyOp(decl, { panel: '杂货铺', op: 'buy', item: '火把' }, {}).error).toMatch(/钱的键/);
  });
  it('摘要：商店不进、装备只报穿着的、空的说空', () => {
    let r = applyOp(decl, { panel: '装备', op: 'equip', item: '草帽', slot: '头' });
    r = applyOp(r.panels, { panel: '装备', op: 'add', item: '备用鞋' });
    expect(digest(r.panels)).toBe('背包：绳子 ｜ 装备（不语）：草帽[头]');
    expect(digest(declarePanels({}, [{ id: 'b', name: '背包', kind: 'inventory' }]))).toBe('背包：空');
  });
});
