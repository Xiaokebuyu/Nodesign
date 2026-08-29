/**
 * lib/chalk-size-pref.js —— 「用户喜欢多宽的板书」（2026-08-28）
 *
 * ## 为什么学得到
 *
 * 板书的**宽是真排版**（前端 BoardObject 的 `width: sz.w` 决定折行），高只是脚印
 * （盒子不设 height，由正文撑）。所以用户拖宽一块板书是一个有信息量的动作：他在说
 * "这个宽度读着舒服"。以前这个动作留不下任何痕迹，下一拍 agent 又按正文估一遍宽，
 * 用户就得反复调同一件事。
 *
 * 学习票源是 `sized: 'user'` —— 前端拖完手柄盖的章，**不是模型能写的东西**
 * （sanitizeObject 白名单收，模型走 patchBoard 也盖不出别人的章）。
 *
 * ## 为什么只学宽不学高
 *
 * 高度跟着正文长短走，一段三行的话和一段三十行的话不该一样高。用户拖高度调的是
 * "这一块留多少空"，那是**这一块**的属性，不是可以套到下一块上的偏好。宽度不同：
 * 它是版心，跨块稳定。硬把高度也套过去，结果是每块板书都拖着一截空白。
 *
 * ## 取最近三块的中位数
 *
 * 板书 id 是 `notes/板书/<时间戳>-<slug>.md`，时间戳可直接字典序排 —— 不用另存时间。
 * 取最近三块：一块就听它的（他刚调完，下一拍就该照做），三块取中位数（一次手滑
 * 拖出个极端值不至于带偏后面所有的）。
 */

/** 网格单位（px）。跟 write_on_board 的 width 参数同一把尺 */
const GRID = 24;
/** 学习窗口：最近几块用户亲手调过的板书 */
const WINDOW = 3;

/**
 * @param {object} board board.json（sanitize 过的）
 * @returns {number|null} 网格单位的宽；没有票就 null（调用方回落按正文估）
 */
export function learnedChalkWidth(board) {
  const votes = Object.entries(board?.objects || {})
    .filter(([id, e]) => e?.sized === 'user' && Number(e.w) > 0 && id.includes('/板书/'))
    .sort(([a], [b]) => (a < b ? 1 : -1))     // id 里的时间戳倒序 = 最近的在前
    .slice(0, WINDOW)
    .map(([, e]) => Math.round(Number(e.w) / GRID));
  if (!votes.length) return null;
  const sorted = [...votes].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  // 回到 write_on_board 的合法区间（schema 是 8..60）；超出就当没学到，别拿一个
  // 会被 schema 打回来的值去顶替一个能用的估算
  return mid >= 8 && mid <= 60 ? mid : null;
}
