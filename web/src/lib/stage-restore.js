/**
 * 重连 / 刷新时把「正在流的入参」续回画布直播卡（2026-09-13，流式与并行现状调查缺口 2）。
 *
 * 服务端 live-turn 快照带 streams（累加到快照 seq 为止的全文，见 server/engine/runs/live-turn.js）。
 * 以前快照里没有这段：流到一半刷新，Edit / Write / 板书的直播卡要么消失，要么从重连后到的第一个增量开始，
 * 只剩后半截。这里按 blockId 立卡或补全文，之后的增量照常 append 接在后面。
 *
 * 纯函数：不改入参；没变化返回原对象（setState 按引用 bail）。
 *
 * @param {Record<string, object>} prev   当前舞台卡（blockId → card）
 * @param {Array<{blockId:string,name:string,filePath?:string|null,spot?:object|null,text:string}>} streams
 * @param {{ kindOf: (name:string)=>string|null, resolve: (filePath:string)=>string|null, newCard: (evt:object, kind:string)=>object }} deps
 */
export function restoreStageCards(prev, streams, { kindOf, resolve, newCard }) {
  if (!Array.isArray(streams) || !streams.length) return prev;
  let next = prev;
  for (const s of streams) {
    if (!s?.blockId || typeof s.text !== 'string') continue;
    const kind = kindOf(s.name);
    if (!kind) continue;
    const c = prev[s.blockId] || newCard({ blockId: s.blockId, name: s.name }, kind);
    // 本地已经比快照长（快照发出后又收到了增量）就不倒退
    const text = s.text.length > (c.text || '').length ? s.text : c.text;
    const filePath = c.filePath || s.filePath || null;
    const objectId = c.objectId || (filePath ? resolve(filePath) : null);
    const spot = s.spot?.solved ? s.spot : (c.spot || s.spot || null);
    if (prev[s.blockId] && text === c.text && filePath === (c.filePath ?? null) && objectId === (c.objectId ?? null) && spot === (c.spot ?? null)) continue;
    if (next === prev) next = { ...prev };
    next[s.blockId] = { ...c, text, filePath, objectId, spot };
  }
  return next;
}
