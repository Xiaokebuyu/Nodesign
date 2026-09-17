/**
 * server/lib/chalk-annotations.js —— 用户贴在一张卡上的蓝字（2026-09-17，板书树刀四）
 *
 * 用户在画布上标注，落下的是一段**蓝色画布字迹**加一条 annotates 线（前端 keepAnnotation）。
 * 板书树的范式是「回复即改写」：agent 改写那张卡之后，那句标注已经被答完了，它就该跟旧正文
 * 一起进历史，而不是留在板上攒着。站主 09-17 的原话是「随着内容被 agent 改写进入折叠」。
 *
 * 撤掉要有交代：调用方把「归档了 N 条标注」报进返回，前端那边卡的版本数会跳一下 ——
 * 否则用户会觉得自己刚写的字凭空没了。
 */

/**
 * 找出贴在这张卡上、由用户写的蓝字标注。
 * @param {object} board  当前板（要 objects 与 bindings；objects 可以传本批改动中的 live 副本）
 * @param {string} targetId  被标注的那张卡
 * @returns {{ ids: string[], edgeIds: string[], texts: string[] }}
 */
export function userAnnotationsOn(board, targetId) {
  const objects = board?.objects || {};
  const ids = []; const edgeIds = []; const texts = [];
  for (const [bid, b] of Object.entries(board?.bindings || {})) {
    if (b?.type !== 'annotates' || b.to !== targetId) continue;
    const from = objects[b.from];
    // 只收用户写的画布文字：agent 自己的注不算「有人问了一句」，别顺手把它清了
    if (!from || from.kind !== 'text') continue;
    const byUser = (b.by || from.by) === 'user';
    if (!byUser) continue;
    const t = String(from.data?.t || '').trim();
    ids.push(b.from); edgeIds.push(bid);
    if (t) texts.push(t);
  }
  return { ids, edgeIds, texts };
}

/** 归档用的一行说明（进历史文件的 `> 用户当时标注：…`）；没有标注返回 null */
export function annotationNote(texts) {
  const list = (texts || []).filter(Boolean);
  if (!list.length) return null;
  return list.join(' / ');
}
