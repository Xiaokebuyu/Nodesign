/**
 * server/lib/model-switches.js — 站主给每一行模型开的总闸（2026-09-10）。
 *
 * 起因：上游出事 / 价钱不对 / 某行在乱说话的时候，站主要能**当场把它从全站收走**，
 * 而不是找我改代码再重启（一次重启要等所有在飞的回合，见 nodesign-inspect-channel 那条教训）。
 *
 * 形态刻意做小：一张 `model_id → enabled` 的表，**只记被动过的行**（没记录 = 启用）。
 * 这样内置表加新行不用来这里补一条，也不会留下一堆"其实等于默认"的存量。
 *
 * ⛔ 这里只管**人做的决定**（开关、以及 09-10 追加的"这行几点关门"），不管判断本身 ——
 *    "此刻能不能用"是 model-availability.js 的事。两件事分开的理由：决定要落库要留痕，
 *    判断每次请求现算、不落任何存储。
 *
 * 关门时段有**三个状态**，别塌成两个（这类三态最常被写成 truthy 判断，然后"取消"就永远做不到）：
 *   hours_json IS NULL     没设过 → 用模型表里这行自己声明的（内置行大多有）
 *   hours_json = 'null'    站主**显式取消**了关门 → 这行 24 小时开门，哪怕表里写着窗口
 *   hours_json = {...}     站主自己定的窗口，盖过表里那份
 * ⛔ 停用**不会**把正在用它的会话搬到别的行（站主 09-10：先别加 fallback）——
 *    下一发拦下、告诉用户自己换一行。搬会话是另一件事，要做得先想清楚"用户没同意就换了模型"。
 */

import db from '../engine/runs/store.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS model_switches (
    model_id   TEXT PRIMARY KEY,
    enabled    INTEGER NOT NULL DEFAULT 1,
    note       TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by TEXT
  );
`);
// 09-10 当天追加：关门时段也能在管理台上改（含内置行）。建过表的库走 ALTER
{
  const cols = new Set(db.prepare('PRAGMA table_info(model_switches)').all().map((c) => c.name));
  if (!cols.has('hours_json')) db.exec('ALTER TABLE model_switches ADD COLUMN hours_json TEXT');
}

const qAll = db.prepare('SELECT model_id, enabled, note, hours_json, updated_at, updated_by FROM model_switches');
const qOne = db.prepare('SELECT enabled, hours_json FROM model_switches WHERE model_id = ?');
const qUpsert = db.prepare(`
  INSERT INTO model_switches (model_id, enabled, note, updated_at, updated_by)
  VALUES (@modelId, @enabled, @note, datetime('now'), @updatedBy)
  ON CONFLICT(model_id) DO UPDATE SET
    enabled = excluded.enabled, note = excluded.note,
    updated_at = excluded.updated_at, updated_by = excluded.updated_by
`);
// 只动关门时段那一列：**别顺手把 enabled 也写一遍**（改时段不该把一行悄悄打开）
const qUpsertHours = db.prepare(`
  INSERT INTO model_switches (model_id, enabled, hours_json, updated_at, updated_by)
  VALUES (@modelId, 1, @hoursJson, datetime('now'), @updatedBy)
  ON CONFLICT(model_id) DO UPDATE SET
    hours_json = excluded.hours_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by
`);

/**
 * 这一行被站主关掉了吗。**没记录 = 启用**（表里只有被动过的行）。
 * @param {string} modelId
 * @returns {boolean}
 */
export function isModelDisabled(modelId) {
  if (!modelId) return false;
  const row = qOne.get(modelId);
  return !!row && !row.enabled;
}

/**
 * 站主给这行定的关门时段。**三态**：
 * @returns {undefined} 没设过（用行自己声明的）| {null} 显式取消 | {object} 站主定的那份
 */
export function hoursOverrideOf(modelId) {
  if (!modelId) return undefined;
  const row = qOne.get(modelId);
  if (!row || row.hours_json == null) return undefined;
  try { return JSON.parse(row.hours_json); } catch { return undefined; }   // 存坏了当没设过，别拖垮请求
}

/**
 * 设 / 清这行的关门时段。
 * @param {string} modelId
 * @param {object|null|undefined} spec 对象 = 这么关；null = 显式取消关门；undefined = 撤回设置，回到行自己声明的那份
 */
export function setModelHours(modelId, spec, meta = {}) {
  if (!modelId || typeof modelId !== 'string') throw new Error('setModelHours: modelId 必填');
  qUpsertHours.run({
    modelId,
    hoursJson: spec === undefined ? null : JSON.stringify(spec),
    updatedBy: meta.updatedBy ?? null,
  });
  return hoursOverrideOf(modelId);
}

/** 被关掉的行 id（管理台列表、日志用）。@returns {Set<string>} */
export function disabledModelIds() {
  return new Set(qAll.all().filter((r) => !r.enabled).map((r) => r.model_id));
}

/** 动过的行的全部记录：id → {enabled, note, updatedAt, updatedBy}。管理台要显示"谁什么时候关的" */
export function listModelSwitches() {
  const out = new Map();
  for (const r of qAll.all()) {
    let hours;   // undefined = 没设过；null = 显式取消；对象 = 站主定的
    if (r.hours_json != null) { try { hours = JSON.parse(r.hours_json); } catch { hours = undefined; } }
    out.set(r.model_id, { enabled: !!r.enabled, note: r.note || null, hours, hoursSet: r.hours_json != null, updatedAt: r.updated_at, updatedBy: r.updated_by || null });
  }
  return out;
}

/**
 * 开 / 关一行。
 * ⚠️ 这里**不校验 modelId 在不在表里**：行有可能是先关掉、以后才加回来的（或者反过来），
 *    留一条对不上的记录不会有任何后果（读的一侧按 id 查）。校验放在管理接口那层，那儿知道当下有哪些行。
 * @param {string} modelId
 * @param {boolean} enabled
 * @param {{note?: string|null, updatedBy?: string|null}} [meta]
 */
export function setModelEnabled(modelId, enabled, meta = {}) {
  if (!modelId || typeof modelId !== 'string') throw new Error('setModelEnabled: modelId 必填');
  qUpsert.run({
    modelId,
    enabled: enabled ? 1 : 0,
    note: meta.note ?? null,
    updatedBy: meta.updatedBy ?? null,
  });
  return { modelId, enabled: !!enabled, note: meta.note ?? null, updatedBy: meta.updatedBy ?? null };
}
