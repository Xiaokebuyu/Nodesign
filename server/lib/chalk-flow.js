/**
 * server/lib/chalk-flow.js —— 长文自动分条（write_on_board 的 flow，2026-08-30）
 *
 * ## 为什么要有这个文件
 *
 * 「剩 15 行、我这段是 14 行还是 16 行」这道算术模型做不准，也不该由它做 ——
 * proj_mtfpehm3 首场真会话 14 发 board_batch 挂了 6 发，全是容量拒收，本质全是
 * 这道算术。flow 把它拿走：agent 交整段内容，机器按**段落边界**拆成若干条
 * ≤ 一张卡高的小板书，链着往版位/纸里排，装到哪儿是哪儿，装不下的**原样退回**
 * （绝不静默丢、绝不硬挤、绝不替它翻页 —— 刀 F 的教义一条不破）。
 *
 * ## 拆分纪律
 *
 *   1. 只在**空行**处拆，且空行必须在围栏（``` fence）外 —— 代码块/nd:controls/
 *      表格永远整块走，切开它们比写不下更坏。
 *   2. 单块超高时降级到**句子边界**（。！？.!?; 换行也算），仍不切词。
 *   3. 一句话就超高的（极少）：整句放行，靠既有的折叠 + 如实报兜底。
 *   4. 贪心装填：往当前条里续块，直到再续就超 maxH。
 */

import { textBox } from './sketch-layout.js';

const FENCE_LINE = /^[ \t]*```/;

/**
 * 按空行拆块（围栏内的空行不算边界）。
 * @returns {string[]} 原文顺序的块，各自 trim 过、非空
 */
export function splitBlocks(body) {
  const lines = String(body || '').split(/\r?\n/);
  const blocks = [];
  let cur = [];
  let inFence = false;
  const push = () => {
    const t = cur.join('\n').trim();
    if (t) blocks.push(t);
    cur = [];
  };
  for (const l of lines) {
    if (FENCE_LINE.test(l)) inFence = !inFence;
    if (!inFence && !l.trim()) { push(); continue; }
    cur.push(l);
  }
  push();
  return blocks;
}

/** 单块超高时的降级：按句子边界拆（不切词；拆不动就原样一块） */
function splitSentences(block) {
  const parts = String(block).split(/(?<=[。！？!?；;])\s*/).filter((s) => s.trim());
  return parts.length > 1 ? parts : [block];
}

/**
 * 把长文拆成若干条小板书的正文。
 *
 * @param {string} body
 * @param {object} opts
 * @param {number} opts.wUnits  目标宽（格数，24px 一格）—— 跟真落板同一把尺
 * @param {string} [opts.size]  字号档（同 write_on_board 的 size）
 * @param {number} opts.maxH    单条上限（px；通常 CARD_MAX_H）
 * @returns {string[]}  每条的正文。measure 用的是 textBox —— 跟落位那一刻同一个
 *   函数量出来的数，不存在"估的和真的不一样"这层误差。
 */
export function flowChunks(body, { wUnits, size = 'md', maxH }) {
  const measure = (t) => textBox(t, size === 'sm' ? 'md' : size, { md: true, wUnits }).h;
  const fits = (t) => measure(t) <= maxH;

  // 先把超高的单块降级拆开，得到一串"每个都尽量 ≤ maxH"的原子
  const atoms = [];
  for (const b of splitBlocks(body)) {
    if (fits(b)) { atoms.push(b); continue; }
    for (const s of splitSentences(b)) atoms.push(s);
  }
  if (!atoms.length) return [];

  // 贪心装填：能续就续。用 \n\n 拼回 —— 空行本来就是它们之间的边界
  const chunks = [];
  let cur = atoms[0];
  for (const a of atoms.slice(1)) {
    const joined = `${cur}\n\n${a}`;
    if (fits(joined)) { cur = joined; continue; }
    chunks.push(cur);
    cur = a;
  }
  chunks.push(cur);
  return chunks;
}
