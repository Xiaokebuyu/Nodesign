/**
 * board-controls —— nd:controls 控件块的生命周期判据（2026-08-25）
 *
 * 控件是通用按钮（每枚 = 一条待发提示词），不只是章节选项：背包、商店、快捷指令、
 * 设置面板都是它。多个控件块**必须能同时活着**（用户 08-25 提），所以失效由块自己
 * 声明，三档：
 *   1. 默认**常设**：永不自动失效（背包/商店这类面板的自然态）
 *   2. `supersede: <组名>` 指令行：同组更新的块落地，旧的变灰 —— 章节选项的死期
 *      是剧情推进，这一档就是给它的（组名与画布 tag 无关，纯控件层的概念）
 *   3. `until: +30m | ISO` 指令行：定时（判据在 MdInk 的 controlsExpired）
 *
 * ⚠️ 08-25 当天曾按「板书 tag」判 supersede —— 背包和章节选项都挂 状态板/章节 tag
 * 时会互相误杀，当天改成显式声明。tag 管版面分组，控件生命周期不搭它的车。
 */

const FENCE_RE = /```nd:controls\n([\s\S]*?)```/;

/** 从板书正文里抽控件块的元信息（没有控件块返回 null） */
export function controlsMetaOf(text) {
  const m = FENCE_RE.exec(String(text || ''));
  if (!m) return null;
  const sup = /^\s*supersede:\s*(.+?)\s*$/m.exec(m[1]);
  return { supersede: sup ? sup[1] : null };
}

/**
 * 一批板书里哪些的控件块已被同组更新者顶掉。
 * @param {Array<{id: string, text: string}>} chalks —— 板书文件名带时间戳，id 字典序即时间序
 * @returns {Set<string>} 该变灰的板书 id
 */
export function staleControlIds(chalks) {
  const byGroup = new Map();
  for (const c of chalks || []) {
    const meta = controlsMetaOf(c.text);
    if (!meta?.supersede) continue;
    if (!byGroup.has(meta.supersede)) byGroup.set(meta.supersede, []);
    byGroup.get(meta.supersede).push(c.id);
  }
  const stale = new Set();
  for (const ids of byGroup.values()) {
    if (ids.length < 2) continue;
    for (const id of [...ids].sort().slice(0, -1)) stale.add(id);
  }
  return stale;
}
