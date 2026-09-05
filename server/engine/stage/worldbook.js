/**
 * engine/stage/worldbook.js —— 世界书的机械触发（2026-09-06，站主问"四方世界这种跑团卡有没有优化"）
 *
 * 酒馆的 lorebook 靠关键词把条目插进上下文；我们这边条目已经是文件（read_tavern_json export_book 一条一文件，
 * frontmatter 带 keys），但 09-05 那版只让演出进程自己 Grep —— 几百条的跑团卡它不会每句都去翻，翻了也是猜。
 * 这里把关键词匹配做成机械的：每句话到时，拿**玩家这句 + 上一段正文**去撞所有触发条目的 keys，命中的接在
 * 这句话的尾巴（消息体，不进冻结的系统提示词，缓存不受影响）。四条 / 三千字封顶，同一条三段内不重复带。
 *
 * 只认 世界书/ 下的触发条目：常驻/ 子目录和 constant:true 的不扫（那些该由 agent 挑十条以内进设定）。
 * keys 两种写法都认：`keys: ["a","b"]`（导出的）和 `keys: [a, b]`（agent 手写的）。正则键（/…/）跳过。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { WORLD_DIR, readPlayConfig } from './play.js';
import { readScenes } from './tools.js';

export const LORE_MAX_ENTRIES = 4;
export const LORE_MAX_CHARS = 3000;
export const LORE_COOLDOWN_BEATS = 3;
const CONSTANT_DIR = '常驻';

function parseKeys(raw) {
  const m = /^keys:\s*(.+)$/m.exec(raw);
  if (!m) return [];
  let v = m[1].trim();
  if (v.startsWith('[')) v = v.replace(/^\[|\]$/g, '');
  return v.split(',').map(k => k.trim().replace(/^["']|["']$/g, '')).filter(k => k && !/^\/.*\/[a-z]*$/.test(k));
}

/** 读全部触发条目（每次都从磁盘扫；几百个小文件一次几十毫秒，比缓存对不上便宜） */
export async function loadWorldbook(playAbs) {
  const root = path.join(playAbs, WORLD_DIR);
  const out = [];
  const walk = async (rel) => {
    for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (e.name !== CONSTANT_DIR) await walk(r); continue; }
      if (!e.name.endsWith('.md')) continue;
      const raw = await fs.readFile(path.join(root, r), 'utf8').catch(() => '');
      const fmm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
      const fm = fmm ? fmm[1] : '';
      if (/^constant:\s*true/m.test(fm)) continue;
      const keys = parseKeys(fm);
      if (!keys.length) continue;
      const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim() || e.name.replace(/\.md$/, '');
      out.push({ rel: `${WORLD_DIR}/${r}`, name, keys, text: (fmm ? raw.slice(fmm[0].length) : raw).trim() });
    }
  };
  await walk('');
  return out;
}

/**
 * 拿一段文字撞条目。返回命中的（按命中键数多的在前），封顶数量与字数。
 * @param {Array} entries  loadWorldbook 的结果
 * @param {string} text    玩家这句 + 上一段正文
 * @param {{skip?: Set<string>, max?: number, maxChars?: number}} opts  skip 里的名字不带（冷却中）
 */
export function matchEntries(entries, text, { skip = new Set(), max = LORE_MAX_ENTRIES, maxChars = LORE_MAX_CHARS } = {}) {
  const hay = String(text || '').toLowerCase();
  if (!hay) return [];
  const hits = [];
  for (const e of entries) {
    if (skip.has(e.name)) continue;
    const n = e.keys.filter(k => hay.includes(k.toLowerCase())).length;
    if (n) hits.push({ ...e, hits: n });
  }
  hits.sort((a, b) => b.hits - a.hits || a.text.length - b.text.length);
  const out = []; let chars = 0;
  for (const h of hits) {
    if (out.length >= max) break;
    const t = h.text.length > 1800 ? `${h.text.slice(0, 1800)}\n…（截断，全文在 ${h.rel}）` : h.text;
    if (chars + t.length > maxChars && out.length) break;
    out.push({ ...h, text: t }); chars += t.length;
  }
  return out;
}

/** 接在这句话尾巴上的那段 */
export function loreNote(matched) {
  if (!matched?.length) return '';
  return matched.map(m => `【世界书 · ${m.name}】\n${m.text}`).join('\n\n');
}

/**
 * 每句话到时：拿玩家这句 + 上一段正文撞触发条目，命中的接在这句话尾巴上。
 * 同一条三段内不重复带（rt.loreSeen 记着上次带它是第几段）；玩家在开场页 / 设定页关掉的（config.lore.off）不送。命中了给显示器报一声。
 */
export async function pickLore(rt, text) {
  let entries = [];
  try { entries = await loadWorldbook(rt.playAbs); } catch { return ''; }
  if (!entries.length) return '';
  const beat = rt.state?.['拍数'] || 0;
  rt.loreSeen = rt.loreSeen || new Map();
  const skip = new Set([...rt.loreSeen].filter(([, at]) => beat - at < LORE_COOLDOWN_BEATS).map(([n]) => n));
  for (const n of (await readPlayConfig(rt.playAbs))?.lore?.off || []) skip.add(n);
  const last = (await readScenes(rt.playAbs, { limit: 6, rel: rt.scenesRel })).reverse().find(r => r.by === 'stage')?.text || '';
  const matched = matchEntries(entries, `${text}\n${last}`, { skip });
  if (!matched.length) return '';
  for (const m of matched) rt.loreSeen.set(m.name, beat);
  rt.broadcast({ type: 'lore', titles: matched.map(m => m.name) });
  return loreNote(matched);
}
