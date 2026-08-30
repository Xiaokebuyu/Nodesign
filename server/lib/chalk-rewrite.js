/**
 * server/lib/chalk-rewrite.js —— 「重写一条板书的正文」这一件事，收成一份
 * （2026-08-30）
 *
 * 在这之前只有 `edit_board` 的 set_text 会做这件事（edit-board.js 的板书文件分支），
 * 而它做对了三件容易漏的：
 *   1. 读原文 → 只换 body，frontmatter 逐字保留（by/at/anchor/reply_to/tag/session）
 *      —— `renderChalk` 只回写白名单键，拼错一个键就是整行静默丢失
 *   2. 宽度沿用现有的（改正文不该改版心），高度按新正文重算
 *   3. **用户亲手拖出来的留白留得住**（`sized:'user'` 时取重算高与现高的较大者）
 *      —— 他调的是「这一块留多少空」，重写一次正文就抹掉，是把他的排版意图当缓存
 *
 * `set_vars` 要做的是同一件事（改表里一格 = 重写这条板书的正文），所以这里抽出来
 * 两处共用，而不是抄第二份。抄的话第 3 条几乎必然被漏掉 —— 它是三条里唯一
 * 「漏了也不报错、只是用户的排版悄悄没了」的那条。
 *
 * ⚠️ 笔权（只有作者本人能改自己的话）**不在这里判** —— 那是调用方的事：
 * edit_board 按 `by` 判，set_vars 有自己的规矩（状态表是场务件不是谁的台词）。
 * 放进来会让两个调用方共享一条它们其实不共享的语义。
 */

import { promises as fs } from 'node:fs';
import { parseChalk, renderChalk } from './chalk.js';
import { UNIT, textBox } from './sketch-layout.js';

/**
 * 重写一条板书文件的正文，并算出它在板上的新尺寸。
 *
 * @param {string} abs      板书文件的绝对路径
 * @param {string} body     新正文
 * @param {object} entry    这条板书在 board.json 里的条目（要 w / h / sized / by）
 * @returns {Promise<{ w:number, h:number }>} 新的盒子（宽沿用、高按正文重算）
 * @throws  文件读不到 / 写不进时抛，调用方自己决定怎么说
 */
export async function rewriteChalkBody(abs, body, entry = {}) {
  const parsed = parseChalk(await fs.readFile(abs, 'utf8'));
  const c = parsed.chalk || {};
  await fs.writeFile(abs, renderChalk({
    body,
    by: c.by || entry.by || 'agent',
    ...(c.at ? { at: c.at } : {}),
    anchor: c.anchor,
    replyTo: c.replyTo,
    tag: c.tag,
    sessionId: parsed.sessionId,
  }), 'utf8');

  const box = textBox(body, 'md', { md: true, wUnits: Math.max(8, Math.round((entry.w || 432) / UNIT)) });
  const h = entry.sized === 'user' ? Math.max(box.h, Number(entry.h) || 0) : box.h;
  return { w: box.w, h };
}
