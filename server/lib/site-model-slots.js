/**
 * server/lib/site-model-slots.js — 站点自己配的模型行，存库那一半（2026-09-10）。
 *
 * 站主要的是"加一个模型不用找人改代码"。形状**不新发明**：跟本地分发版的插槽
 * （runtime/local-config.js 那个 config.json）**同一套字段、同一个校验**，只是换了个存放处 ——
 * 单机存文件，站点存库。这样配置页的表单、内置表的注释、校验器三处说的还是同一件事。
 *
 * 只存一份文档（id=1 的那行），整份读整份写：
 *   { "upstreams": { … }, "models": [ … ] }
 *
 * ⛔ 这里**不做校验**（那是 runtime/slot-config.js 的事，它跟本地那份共用一个 validate）。
 *    这个文件只负责"存进去 / 拿出来"，不认识模型是什么 —— 存储层认识业务字段是下一个真相源的开始。
 * ⚠️ 半成品照存：站主在页面上编到一半保存，也要能存下来（页面标红告诉他哪儿不对）。
 *    真正决定"哪些行进表"的是 buildIndex，坏行在那儿被整条丢掉，站不会因此起不来。
 */

import db from '../engine/runs/store.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS site_model_config (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    json       TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by TEXT
  );
`);

const qGet = db.prepare('SELECT json, updated_at, updated_by FROM site_model_config WHERE id = 1');
const qPut = db.prepare(`
  INSERT INTO site_model_config (id, json, updated_at, updated_by)
  VALUES (1, @json, datetime('now'), @updatedBy)
  ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at, updated_by = excluded.updated_by
`);

const EMPTY = { upstreams: {}, models: [] };

/**
 * 拿出来。没存过 = 空配置（不是错）；存进去的 JSON 坏了也当空配置 + 一条错
 * （库里的 JSON 是我们自己写的，坏了是 bug，但别让它把整站拉不起来）。
 * @returns {{raw: object, updatedAt: string|null, updatedBy: string|null, errors: {where: string, message: string}[]}}
 */
export function readSiteSlots() {
  const row = qGet.get();
  if (!row) return { raw: EMPTY, updatedAt: null, updatedBy: null, errors: [] };
  try {
    const raw = JSON.parse(row.json);
    return { raw: raw && typeof raw === 'object' ? raw : EMPTY, updatedAt: row.updated_at, updatedBy: row.updated_by || null, errors: [] };
  } catch (err) {
    return { raw: EMPTY, updatedAt: row.updated_at, updatedBy: row.updated_by || null, errors: [{ where: '(库)', message: `站点模型配置不是合法 JSON：${err.message}` }] };
  }
}

/**
 * 整份写回。调用方（管理接口）负责先校验、把校验结果回给页面。
 * @param {object} raw {upstreams, models}
 * @param {{updatedBy?: string|null}} [meta]
 */
export function writeSiteSlots(raw, meta = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('站点模型配置必须是一个对象 { upstreams, models }');
  qPut.run({ json: JSON.stringify(raw), updatedBy: meta.updatedBy ?? null });
  return readSiteSlots();
}
