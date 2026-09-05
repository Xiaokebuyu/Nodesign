/**
 * engine/stage/panels.js —— 面板：清单类的结构化状态（2026-09-06，站主要背包 / 装备 / 商店这类模板页）
 *
 * 状态值（vitals）是标量：好感 62、时间 08:00。跑团卡还有一类东西是**清单**：背包里有什么、身上穿什么、
 * 铺子里卖什么。它们不是一个数，是一组带数量 / 价格 / 槽位的条目。这里把它们做成**面板**：
 *
 *   <故事>/面板.json  { panels: { 背包: { id, name, kind, who?, slots?, currency?, items: [...] } } }
 *   kind：inventory（背包）/ equipment（装备与穿着，带 slots，可挂在某个人 who 身上）/ shop（商店，条目带 price）/ list（泛清单）
 *   item：{ name, qty, note?, tags?, price?, slot?, equipped? }
 *
 * 改动只有几种机械动作（applyOp）：add / remove / set / equip / unequip / clear / price / buy。
 * 演出进程用 update_panel 调它们（写在 write_scene 之前）；玩家在显示器点"买 / 用 / 装上"走同一个函数。
 * 玩家改的东西演出进程还不知道 → 记一条【面板变化】随下一句话带过去（manager 的 pendingNotes）。
 * 每句话的「此刻」行后面带一行面板摘要（digest），模型每段都看得见自己有什么。
 *
 * ⛔ 数字只在这里，不进正文：跟状态值同一条纪律。
 */

import path from 'node:path';
import fs from 'node:fs/promises';

export const PANELS_FILE = '面板.json';
export const PANEL_KINDS = ['inventory', 'equipment', 'shop', 'list'];
const KIND_NAME = { inventory: '背包', equipment: '装备', shop: '商店', list: '清单' };

export async function readPanels(playAbs) {
  try { const j = JSON.parse(await fs.readFile(path.join(playAbs, PANELS_FILE), 'utf8')); return j?.panels && typeof j.panels === 'object' ? j.panels : {}; } catch { return {}; }
}
export async function writePanels(playAbs, panels) {
  await fs.mkdir(playAbs, { recursive: true });
  const tmp = path.join(playAbs, `${PANELS_FILE}.tmp`);
  await fs.writeFile(tmp, JSON.stringify({ panels }, null, 2), 'utf8');
  await fs.rename(tmp, path.join(playAbs, PANELS_FILE));
}

/** 声明（open_stage 的 panels）→ 落盘。已有的面板保留条目，只更新元数据；没声明过的建空的 */
export function declarePanels(existing, decls) {
  const out = { ...existing };
  for (const d of decls || []) {
    const id = String(d.id || d.name || '').trim();
    if (!id) continue;
    const kind = PANEL_KINDS.includes(d.kind) ? d.kind : 'list';
    const prev = out[id];
    out[id] = {
      id, name: String(d.name || id).slice(0, 20), kind,
      ...(d.who ? { who: String(d.who).slice(0, 30) } : {}),
      ...(kind === 'equipment' ? { slots: (d.slots || prev?.slots || ['头', '身', '手', '脚', '饰品']).slice(0, 12) } : {}),
      ...(kind === 'shop' && d.currency ? { currency: String(d.currency).slice(0, 20) } : (prev?.currency ? { currency: prev.currency } : {})),
      ...(d.into ? { into: String(d.into).slice(0, 20) } : (prev?.into ? { into: prev.into } : {})),
      items: prev?.items || (d.items || []).map(normItem).filter(Boolean),
    };
  }
  return out;
}

function normItem(it) {
  if (!it) return null;
  const name = String(it.name || '').trim().slice(0, 40);
  if (!name) return null;
  const o = { name, qty: Number.isFinite(Number(it.qty)) ? Math.max(0, Math.round(Number(it.qty))) : 1 };
  if (it.note) o.note = String(it.note).slice(0, 120);
  if (Array.isArray(it.tags) && it.tags.length) o.tags = it.tags.map(t => String(t).slice(0, 12)).slice(0, 6);
  if (it.price !== undefined && Number.isFinite(Number(it.price))) o.price = Number(it.price);
  if (it.slot) o.slot = String(it.slot).slice(0, 12);
  if (it.equipped) o.equipped = true;
  return o;
}

/**
 * 一步机械动作。返回 { panels, change: '一句人话', error? }。不抛：错了把原因写在 error 里让模型自己改。
 * op：
 *   add    {panel, item, qty?, note?, price?, slot?, tags?}   有同名条目就加数量
 *   remove {panel, item, qty?}                                不给 qty 整条拿掉
 *   set    {panel, item, qty?, note?, price?, slot?}          改数量 / 备注 / 价格 / 槽位（没有就建）
 *   equip  {panel(equipment), item, slot?}                    穿上：同槽位原来那件脱下
 *   unequip{panel(equipment), item}
 *   clear  {panel}
 *   price  {panel(shop), item, price}
 *   buy    {panel(shop), item, qty?, state}                   玩家买：扣 currency（state 里那把钥匙）、进 into 那个背包；state 不够钱就 error
 */
export function applyOp(panels, op, state = {}) {
  const P = { ...panels };
  const pid = String(op.panel || '').trim();
  // 演出进程中途开一块新面板（走进铁匠铺 / 捡到一个包）或收掉一块（离开了那家店）
  if (op.op === 'open') {
    if (!pid) return { panels, error: 'open 要给 panel（面板名）' };
    if (P[pid]) return { panels, error: `已经有「${pid}」了，直接往里 add` };
    const next = declarePanels(P, [{ id: pid, name: op.name || pid, kind: op.kind || 'list', who: op.who, slots: op.slots, currency: op.currency, into: op.into, items: op.items }]);
    return { panels: next, change: `开了一块面板「${next[pid].name}」（${KIND_NAME[next[pid].kind]}${next[pid].who ? `，${next[pid].who} 的` : ''}）` };
  }
  if (op.op === 'close') {
    if (!P[pid]) return { panels, error: `没有叫「${pid}」的面板` };
    const { [pid]: gone, ...rest } = P;
    return { panels: rest, change: `收掉了面板「${gone.name}」` };
  }
  const p = P[pid];
  if (!p) return { panels, error: `没有叫「${op.panel}」的面板；有的是：${Object.keys(P).join('、') || '一个都没有'}` };
  const items = p.items.map(x => ({ ...x }));
  const find = () => items.findIndex(x => x.name === String(op.item || '').trim());
  const name = String(op.item || '').trim();
  const qty = op.qty === undefined ? 1 : Math.max(0, Math.round(Number(op.qty) || 0));
  let change = '';
  let stateChange = null;
  switch (op.op) {
    case 'add': {
      if (!name) return { panels, error: 'add 要给 item' };
      const i = find();
      if (i >= 0) { items[i].qty += qty; if (op.note) items[i].note = String(op.note).slice(0, 120); change = `${p.name}：${name} ×${items[i].qty}（+${qty}）`; }
      else { const it = normItem({ name, qty, note: op.note, price: op.price, slot: op.slot, tags: op.tags }); items.push(it); change = `${p.name}：+${name}${qty > 1 ? ` ×${qty}` : ''}`; }
      break;
    }
    case 'remove': {
      const i = find(); if (i < 0) return { panels, error: `${p.name} 里没有「${name}」` };
      if (op.qty === undefined || items[i].qty <= qty) { items.splice(i, 1); change = `${p.name}：−${name}`; }
      else { items[i].qty -= qty; change = `${p.name}：${name} ×${items[i].qty}（−${qty}）`; }
      break;
    }
    case 'set': {
      if (!name) return { panels, error: 'set 要给 item' };
      let i = find();
      if (i < 0) { items.push(normItem({ name, qty: op.qty ?? 1 })); i = items.length - 1; }
      if (op.qty !== undefined) items[i].qty = qty;
      if (op.note !== undefined) items[i].note = String(op.note).slice(0, 120);
      if (op.price !== undefined) items[i].price = Number(op.price);
      if (op.slot !== undefined) items[i].slot = String(op.slot).slice(0, 12);
      if (items[i].qty === 0) items.splice(i, 1);
      change = `${p.name}：${name}${op.qty !== undefined ? ` ×${qty}` : ''}${op.note !== undefined ? '（备注改了）' : ''}`;
      break;
    }
    case 'equip': {
      if (p.kind !== 'equipment') return { panels, error: `${p.name} 不是装备面板` };
      let i = find();
      if (i < 0) { items.push(normItem({ name, qty: 1, slot: op.slot })); i = items.length - 1; }
      const slot = op.slot || items[i].slot || '';
      if (slot) { items[i].slot = slot; for (const x of items) if (x !== items[i] && x.slot === slot && x.equipped) x.equipped = false; }
      items[i].equipped = true;
      change = `${p.name}：穿上 ${name}${slot ? `（${slot}）` : ''}`;
      break;
    }
    case 'unequip': {
      const i = find(); if (i < 0) return { panels, error: `${p.name} 里没有「${name}」` };
      items[i].equipped = false; change = `${p.name}：脱下 ${name}`;
      break;
    }
    case 'clear': items.length = 0; change = `${p.name}：清空`; break;
    case 'price': {
      const i = find(); if (i < 0) return { panels, error: `${p.name} 里没有「${name}」` };
      items[i].price = Number(op.price) || 0; change = `${p.name}：${name} 价 ${items[i].price}`;
      break;
    }
    case 'buy': {
      if (p.kind !== 'shop') return { panels, error: `${p.name} 不是商店` };
      const i = find(); if (i < 0) return { panels, error: `${p.name} 没有「${name}」` };
      const it = items[i];
      const cost = (it.price || 0) * qty;
      if (p.currency) {
        const have = Number(state[p.currency]);
        if (!Number.isFinite(have)) return { panels, error: `状态里没有「${p.currency}」这个钱的键，买不了` };
        if (have < cost) return { panels, error: `${p.currency} 只有 ${have}，${name}${qty > 1 ? ` ×${qty}` : ''} 要 ${cost}` };
        stateChange = { [p.currency]: have - cost };
      }
      if (it.qty !== undefined && it.qty < 9999) { it.qty -= qty; if (it.qty <= 0) items.splice(i, 1); }
      const intoId = p.into || Object.values(P).find(x => x.kind === 'inventory')?.id;
      if (intoId && P[intoId]) {
        const inv = { ...P[intoId], items: P[intoId].items.map(x => ({ ...x })) };
        const j = inv.items.findIndex(x => x.name === name);
        if (j >= 0) inv.items[j].qty += qty; else inv.items.push(normItem({ name, qty, note: it.note, tags: it.tags }));
        P[intoId] = inv;
      }
      change = `买了 ${name}${qty > 1 ? ` ×${qty}` : ''}${p.currency ? `，${p.currency} ${state[p.currency]} → ${stateChange[p.currency]}` : ''}${intoId ? `，进了 ${P[intoId]?.name || intoId}` : ''}`;
      break;
    }
    default: return { panels, error: `不认识的 op：${op.op}` };
  }
  P[p.id] = { ...p, items };
  return { panels: P, change, stateChange };
}

/** 一行摘要，接在「此刻」后面（每句话都带；300 字封顶） */
export function digest(panels, max = 300) {
  const parts = [];
  for (const p of Object.values(panels || {})) {
    if (p.kind === 'shop') continue;   // 铺子里卖什么模型自己写的，不用每句重复
    const items = p.items.filter(x => p.kind !== 'equipment' || x.equipped);
    if (!items.length) { parts.push(`${p.name}：空`); continue; }
    parts.push(`${p.name}${p.who ? `（${p.who}）` : ''}：${items.map(x => `${x.name}${x.qty > 1 ? `×${x.qty}` : ''}${x.slot && p.kind === 'equipment' ? `[${x.slot}]` : ''}`).join('、')}`);
  }
  const s = parts.join(' ｜ ');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export { KIND_NAME };
