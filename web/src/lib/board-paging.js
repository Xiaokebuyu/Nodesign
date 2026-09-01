/**
 * board-paging.js —— 一摞纸翻到第几页（2026-09-01 叠纸刀 4，前端半）
 *
 * ## 为什么前端要有这一份
 *
 * 服务端 `lib/board-stacks.js` 是同一件事的权威，但**显示到第几页是看的人自己的
 * 事**，不进 board.json：两个人同时看一块板，一个在读第一拍、一个在读第三拍，
 * 都对。所以这份不是缓存，是另一半 —— 服务端管"一摞里有哪些纸"，这边管"我此刻
 * 看哪一张"。`pilesOf` 那一半跟服务端 `stacksOf` 有逐例 parity（比行为不比常量）。
 *
 * ## 藏起来的只有认领了纸的墨
 *
 * `objects[id].sheet` 是这件东西认领的那一页。没认领的（用户拖进来的散件、
 * 文件夹卡、产物）**一页都不藏** —— 它们不参与叠放，翻到哪一页都看得见。
 * 这跟服务端算占位是同一条判据（board-sheets.js 的 claimedBy），两边一致才不会
 * 出现"屏幕上没有、可服务端说那儿占着地方"。
 */

/** 这张纸属于哪一摞。没登记过就用纸名当摞名（隐式单张摞，存量板全是这样） */
export function stackOfSheet(sheets, sheetId) {
  const s = sheets?.[sheetId];
  if (!s) return null;
  return s.stack || sheetId;
}

/**
 * 板上所有的摞，按阅读序（先上后下、同带先左后右）。摞内按登记时间从早到晚。
 * @returns {Array<{name,x,y,w,h,title,at,sheets:string[],implicit:boolean}>}
 */
export function pilesOf(sheets, stacks) {
  const groups = new Map();
  for (const [id, s] of Object.entries(sheets || {})) {
    if (!Number.isFinite(s?.x) || !Number.isFinite(s?.y)) continue;
    const name = s.stack || id;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push({ id, ...s });
  }
  const out = [];
  for (const [name, members] of groups) {
    members.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')) || a.id.localeCompare(b.id));
    const reg = stacks?.[name] || null;
    const head = members[0];
    out.push({
      name,
      x: head.x, y: head.y,
      w: Math.max(...members.map((m) => m.w)),
      h: Math.max(...members.map((m) => m.h)),
      title: reg?.title || head.title || null,
      at: reg?.at || head.at || '',
      sheets: members.map((m) => m.id),
      implicit: !stacks?.[name],
    });
  }
  return out.sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

/**
 * 这一摞此刻显示第几页。
 *
 * 缺省是**最新那一张**（摞里最后登记的），而且 agent 新开一页会自动跟过去 ——
 * 直到用户自己翻过。翻过之后认他选的那张，除非那张纸没了（撕掉/改名）。
 * 这是相机「用户一接管就让位」的同一条规矩，换到翻页这一轴上。
 */
export function displayedPage(pile, picked) {
  if (!pile?.sheets?.length) return null;
  const want = picked?.[pile.name];
  if (want && pile.sheets.includes(want)) return want;
  return pile.sheets[pile.sheets.length - 1];
}

/**
 * 此刻该藏起来的物件 id。
 *
 * 判据只有一条：这件东西认领了某一页，而它那一摞现在显示的是别的页。
 * 单张摞永远藏不了任何东西（一摞只有一页，显示的就是它）。
 */
export function hiddenByPaging(sheets, stacks, picked) {
  const piles = pilesOf(sheets, stacks);
  const hidden = new Set();
  for (const pile of piles) {
    // 单张摞早退。⚠️ 这是**省一趟循环，不是守卫** —— 摘掉它结果一模一样（下面
    // 那行 `id !== shown` 对单张摞本来就一个都不加）。攻过，确认它不改变行为。
    if (pile.sheets.length < 2) continue;
    const shown = displayedPage(pile, picked);
    for (const id of pile.sheets) if (id !== shown) hidden.add(id);
  }
  return hidden;
}

/** 翻一页：+1 更新的、-1 更早的。到头返回原样（不循环，靠回弹给反馈） */
export function flipTo(pile, picked, dir) {
  const cur = displayedPage(pile, picked);
  const i = pile.sheets.indexOf(cur);
  const next = pile.sheets[i + (dir > 0 ? 1 : -1)];
  return next || cur;
}

/**
 * 视口中心落在哪一摞里。都没落进就取**中心离它最近**的那一摞 ——
 * 翻页器总得有个当前对象，让它在两摞之间的空地上变成空白是坏的。
 */
export function currentPileOf(piles, center) {
  if (!piles?.length || !Number.isFinite(center?.x)) return null;
  const inside = piles.find((p) => center.x >= p.x && center.x < p.x + p.w
    && center.y >= p.y && center.y < p.y + p.h);
  if (inside) return inside;
  let best = null; let bestD = Infinity;
  for (const p of piles) {
    const dx = center.x - (p.x + p.w / 2);
    const dy = center.y - (p.y + p.h / 2);
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/** 左右换摞：到头返回 null */
export function neighborPile(piles, name, dir) {
  const i = piles.findIndex((p) => p.name === name);
  if (i < 0) return null;
  return piles[i + (dir > 0 ? 1 : -1)] || null;
}
