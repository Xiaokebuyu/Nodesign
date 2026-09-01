/**
 * edit-board-ui-ops.js —— edit_board 里**不改板、只改看的人那一侧**的两个动作
 * （2026-09-01 从 edit-board.js 拆出，行数棘轮）
 *
 * `chalk_edit` 拨的是用户的「改板书」开关，`show` 把某一页翻到用户眼前。两个都
 * 一个字都不动 board.json —— 它们改的是「此刻这个人看到什么 / 能动什么」。
 * 收在一处是因为它们的路子一模一样：验一下 → 广播一个 ui 事件 → 前端当场生效，
 * 跟同一个文件里那一堆真在改坐标和关系的 op 不是一类事。
 */
import { readUiConfigFile, writeUiConfig } from '../../../projects/ui-config.js';

/**
 * @returns {{ok:true, report:string} | {error:string}}
 */
export async function applyUiOp(o, { board, ctx, sharedRoot }) {
  if (o.op === 'chalk_edit') {
    // 存 ui-config（重开页面还在），并广播给开着的前端当场生效
    // （08-25 用户提：黑板 RP 这类板书密集会话该由 agent 帮忙打开）
    const cfg = (await readUiConfigFile(sharedRoot)) || {};
    await writeUiConfig(sharedRoot, { ...cfg, chalk_edit: !!o.on });
    try { ctx?.emit?.({ type: 'ui.chalk_edit', sessionId: null, on: !!o.on }); } catch { /* */ }
    return { ok: true, report: `· 改板书开关 → ${o.on ? '开（用户现在可直接拖动/编辑板书）' : '关'}` };
  }
  if (o.op === 'pin_view') {
    /**
     * 钉住/松开用户的视区（叠纸刀 6）。跟 chalk_edit 同一条路：存 ui-config
     * （重开页面还在）+ 广播当场生效。
     *
     * 什么时候该替他钉上：演出开场、或者接下来几拍都写在同一摞上 —— 钉住之后
     * 他不用再满板找你写在哪儿了。⚠️ 钉住**不是不许动**，他照旧能缩放凑近看。
     */
    const cfg = (await readUiConfigFile(sharedRoot)) || {};
    await writeUiConfig(sharedRoot, { ...cfg, pin_view: !!o.on });
    try { ctx?.emit?.({ type: 'ui.pin_view', sessionId: null, on: !!o.on }); } catch { /* */ }
    return { ok: true, report: `· 钉住视区 → ${o.on ? '开（镜头守着当前这一摞，你写在哪一页他都看得见）' : '关'}` };
  }
  /**
   * 把某一页呈到用户眼前（叠纸刀 5）。
   *
   * 叠纸之后一摞纸只画得出最上面那张，别的页在屏幕上完全不存在 —— 用户说
   * 「给我看第二章」时，agent 需要一只手把那一页翻上来。
   *
   * ⚠️ 显示到第几页**不进 board.json**：两个人同时看一块板，一个在读第一拍、
   * 一个在读第三拍，都对。所以这里只发事件、不落盘。
   */
  const target = o.sheet;
  const sh = board.sheets?.[target];
  if (!sh) {
    const names = Object.keys(board.sheets || {});
    return { error: `纸 ${target} 不在板上${names.length ? `（现在有：${names.join('、')}）` : '（一张纸都还没铺）'}` };
  }
  try { ctx?.emit?.({ type: 'ui.show_sheet', sessionId: null, sheet: target }); } catch { /* */ }
  return { ok: true, report: `· show ${target}${sh.title ? `（${sh.title}）` : ''} —— 已翻到用户眼前` };
}
