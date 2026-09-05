/**
 * lib/label-wrap.js —— 线上的字怎么折行（2026-09-05）
 *
 * 线上的 label 从「一个词」变成「一句话」（站主：线要能带 agent 自己的话），
 * 60 字常显在一根短线的中点会挤成一团。按显示宽度折成几行：汉字算 1、拉丁算 0.6，
 * 平时最多 lines 行（多的用 … 收尾），悬停时不截。
 */
const em = (c) => (/[　-鿿＀-￯]/.test(c) ? 1 : 0.6);

/**
 * @param {string} text
 * @param {{perLine?:number, lines?:number}} opts  perLine = 每行几个汉字宽；lines = 最多几行（0 = 不限）
 * @returns {string[]}
 */
export function wrapLabel(text, { perLine = 14, lines = 3 } = {}) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const out = [];
  let cur = ''; let w = 0;
  for (const ch of t) {
    const cw = em(ch);
    if (w + cw > perLine && cur) { out.push(cur); cur = ''; w = 0; }
    cur += ch; w += cw;
  }
  if (cur) out.push(cur);
  if (lines > 0 && out.length > lines) {
    const kept = out.slice(0, lines);
    kept[lines - 1] = `${[...kept[lines - 1]].slice(0, Math.max(1, perLine - 1)).join('')}…`;
    return kept;
  }
  return out;
}
