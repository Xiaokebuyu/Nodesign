/**
 * server/lib/chalk-history.js —— 板书的历史（2026-09-17，板书树刀二）
 *
 * ## 为什么有它
 *
 * 板面从「只增不减」改成「原地重写」之后，一条板书的正文会被反复改写：用户在某张卡上
 * 标注，agent 就把那张卡改写成最新状态。旧正文不能丢，但也不该占板面 —— 它去这里。
 *
 * ## 为什么是伴生文件而不是塞进主文件
 *
 * 塞进主文件的话，agent 顺手 Read 一张卡就是全量历史（上下文当场膨胀），而且每次
 * 改写都要把整份历史读出来再写回去。伴生文件的主文件大小与今天一模一样：渲染、
 * read_board、agent 的 Read 都零膨胀，只有真要翻历史时才打开另一个文件。
 *
 *   notes/板书/配色讨论.md              当前正文
 *   notes/板书/.history/配色讨论.md     历史，最新在上
 *
 * 点号开头的目录不作为卡上画布（画布扫描跳过隐藏目录），所以历史不会变成板上的卡。
 *
 * ## 格式为什么长这样
 *
 * 每一版一个 `## <时间> · 被改写前` 标题行，最新在最上面。这样 `head -60` 就是
 * 「最近几版」，`Grep` 能直接定位到某句话在哪一版 —— agent 的读法纪律（默认只读前
 * 60 行、找内容用 Grep）靠的就是这个形状。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const HISTORY_DIR = '.history';
const HEAD_RE = /^## /gm;

/** 这条板书的历史文件在哪（给绝对路径，返回绝对路径） */
export function historyPathFor(abs) {
  return path.join(path.dirname(abs), HISTORY_DIR, path.basename(abs));
}

/** 本地时间的可读时戳（历史是给人和 agent 读的，不是给机器排序的 —— 文件顺序已经是序） */
function stamp(at = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}`;
}

/**
 * 把「被改写前的那一版」记进历史（最新在上）。
 *
 * @param {string} abs        板书主文件的绝对路径
 * @param {string} oldBody    被替换掉的正文
 * @param {object} [opts]
 * @param {Date}   [opts.at]         这次改写的时间
 * @param {string} [opts.note]       附一行说明（例如用户当时的标注原话）
 * @returns {Promise<number>} 记完之后历史里有几版；空正文不记，返回原有版本数
 */
export async function archiveChalkBody(abs, oldBody, { at = new Date(), note = null } = {}) {
  const body = String(oldBody ?? '').trim();
  if (!body) return historyCountOf(await readHistoryRaw(abs));
  const hp = historyPathFor(abs);
  const prev = await readHistoryRaw(abs);
  const head = `## ${stamp(at)} · 被改写前`;
  const section = `${head}\n\n${note ? `> 用户当时标注：${String(note).replace(/\s+/g, ' ').slice(0, 200)}\n\n` : ''}${body}\n`;
  const next = prev ? `${section}\n${prev.replace(/^\n+/, '')}` : section;
  await fs.mkdir(path.dirname(hp), { recursive: true });
  await fs.writeFile(hp, next, 'utf8');
  return historyCountOf(next);
}

async function readHistoryRaw(abs) {
  try { return await fs.readFile(historyPathFor(abs), 'utf8'); } catch { return ''; }
}

/** 一份历史文本里有几版 */
export function historyCountOf(raw) {
  return String(raw || '').match(HEAD_RE)?.length || 0;
}

/** 这条板书有几版历史（没有历史文件就是 0） */
export async function historyCount(abs) {
  return historyCountOf(await readHistoryRaw(abs));
}

/**
 * 一批板书各有几版历史。read_board 给每张卡标「历史 N 版」用，所以要能一次问一批。
 * @param {string} dir   板书目录（绝对路径）
 * @param {string[]} names  文件名（不带目录）
 * @returns {Promise<Map<string, number>>} 文件名 → 版本数（0 的不进表）
 */
export async function historyCounts(dir, names) {
  const out = new Map();
  await Promise.all([...new Set(names)].map(async (name) => {
    if (!name || name.includes('/') || name.includes('..') || name.startsWith('.')) return;
    const n = await historyCount(path.join(dir, name));
    if (n) out.set(name, n);
  }));
  return out;
}
