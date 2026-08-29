/**
 * web/src/lib/hero.js — 主角判断（2026-08-14，北极星路线 1）
 *
 * 登录墙那种版面第一眼的信息是「哪张是主角」。这个判断不用猜 ——
 * 关系数据里写着：改自链的 from 侧 = 现役版（加分）、to 侧 = 旧版（重罚）、
 * 被自动取材边指着的 = 素材（重罚，素材不该当 hero）、手画线越多 = 越在
 * 讨论焦点。形态基础分只给产物卡（deck/site）—— 一张散图放大两倍
 * 不叫版面叫事故。
 *
 * 保守条款：**主角要有证据**。多张卡并列最高分 → 没有主角（谁都不放大），
 * 版面宁可平也不能随机指定一张 —— 整理必须可预期。唯一产物卡例外：
 * 一个项目就一个站，它就是这个项目的脸，天然主角。
 */

// ⚠️ 加形态时别漏这张表（docx 曾漏了一天：纯 word 项目永远没有主角卡，版面
// 比 site 项目平 —— 「加形态漏掉的写死表」家族第五处）
const ELIGIBLE = new Set(['deck', 'site', 'docx']);
/** 手画线的关注度加分：每条 +0.5，单卡封顶 +1.5（三条线之后不再更"焦点"） */
const FOCUS_PER_EDGE = 0.5;
const FOCUS_CAP = 1.5;

/**
 * @param {Array<{id:string,type:string}>} items  桌面这一层的物件
 * @param {object} bindings                        { [bid]: { type, from, to, by } }
 * @returns {string|null}  主角物件 id；没有主角 → null
 */
export function pickHero(items, bindings) {
  const score = new Map();
  for (const it of items || []) {
    if (ELIGIBLE.has(it.type)) score.set(String(it.id), 3);
  }
  if (!score.size) return null;
  const bump = (id, d) => { if (score.has(id)) score.set(id, score.get(id) + d); };
  const focus = new Map();
  for (const b of Object.values(bindings || {})) {
    if (b.type === 'derives-from') { bump(b.from, 2); bump(b.to, -3); }
    if (b.type === 'ref' && b.by === 'auto') bump(b.to, -3);
    // 「手画的线」= 用户 / 主控 / 常驻角色画的（08-26：RP 场里大半线是角色画的，
    // 只认 user|agent 的话主角推断的信号会大量流失）。auto 那支在上面已单独处理。
    if (b.by && b.by !== 'auto') {
      for (const end of [b.from, b.to]) {
        if (!score.has(end)) continue;
        const used = focus.get(end) || 0;
        if (used >= FOCUS_CAP) continue;
        focus.set(end, used + FOCUS_PER_EDGE);
        bump(end, FOCUS_PER_EDGE);
      }
    }
  }
  const ranked = [...score.entries()].sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0]));
  if (ranked.length === 1) return ranked[0][0];
  if (ranked[0][1] === ranked[1][1]) return null;   // 并列 = 没证据
  return ranked[0][0];
}
