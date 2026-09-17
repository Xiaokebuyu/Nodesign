/**
 * web/src/lib/browse-window.js — 浏览器窗「谁开的、该不该替人收」的状态转移（2026-09-14）
 *
 * 09-14 站主：agent 开浏览器会把大窗弹出来，之后没人管，用户不手动关就一直开着。
 * 定的是**回合结束自动收**，不是给 agent 加关闭参数（它记不得收，这正是现在窗没人管的原因）。
 *
 * 只收 `auto` 的窗 = agent 的 `run.browser_opened` 弹出来、人还没碰过的那扇：
 * - 人自己开的（双击卡片、进程面板「在画布上看」）不收
 * - agent 举手求助（`run.browser_help`）弹的不收 —— 那扇窗就是等人来的
 * - 人在窗里动过（接手 / 放大 / 翻页 / 看采集）就转成人的，不收
 * - 按停（`run.cancelled`）不收：「先按停这一轮才能接手」，停下来往往正是要接手
 *
 * 收的只是窗；实例照旧空闲 5 分钟回收、登录态留着，桌面上那张浏览器卡还在，双击就回来。
 *
 * 窗状态形状：`null` | `{ url: string|null, help: string|null, auto?: boolean }`
 */

/** agent 翻到新页（`run.browser_opened`）：没开就替人弹出来并记成 auto；人的窗只换地址 */
export function onAgentBrowse(prev, url) {
  if (prev && !prev.auto) return { ...prev, url: url || prev.url || null, help: null };
  return { url: url || null, help: null, auto: true };
}

/** 回合正常结束或出错：agent 弹出来、人没碰过、没在求助的窗收掉 */
export function onTurnEnd(prev) {
  return prev?.auto && !prev.help ? null : prev;
}

/** 浏览器实例被关了（空闲回收 / LRU 淘汰）：auto 的窗只剩「浏览器已经关了」的空壳，一起收 */
export const onBrowserGone = onTurnEnd;

/** 人在窗里动过：这扇窗归人了，回合结束不再替他收 */
export function onUserEngaged(prev) {
  return prev?.auto ? { ...prev, auto: false } : prev;
}
