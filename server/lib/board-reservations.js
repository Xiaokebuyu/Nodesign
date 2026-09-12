/**
 * 直播板书的预留座（2026-09-12，第 6 条收尾）。
 *
 * write_on_board 的入参是流式到达的：位置字段（place/near/reply_to/chain）先闭合、text 再流。
 * 服务端在位置字段闭合那一拍就按真求解器解一次落点（write-on-board.js previewChalkSpot），
 * 结果登记在这里：
 *   - 进障碍集（board-obstacles.js，id = `live:<toolUseId>`）：同一轮里紧接着的落位看得见它；
 *   - 工具真落板时（同一个 toolUseId）优先落回预告的位置，只要那块地还空着 —— 前端直播框
 *     立在预告位置上，落盘后不再跳；
 *   - text 继续流时按已流出的正文更新高度（growChalkSpot），预留的面积跟着长。
 * 纯内存，TTL 兜底（工具失败 / 回合中断时不会永远占着一块地）。
 */

const TTL_MS = 120_000;
const store = new Map();   // projectId → Map(toolUseId → { x, y, w, h, zone, wUnits, at })

function bucket(pid) {
  if (!store.has(pid)) store.set(pid, new Map());
  return store.get(pid);
}

export function reserveSpot(pid, toolUseId, rect) {
  if (!pid || !toolUseId || !rect) return null;
  const r = { x: rect.x, y: rect.y, w: rect.w, h: rect.h, zone: rect.zone || '', wUnits: rect.wUnits || null, at: Date.now() };
  bucket(pid).set(toolUseId, r);
  return r;
}

export function updateReservation(pid, toolUseId, patch) {
  const r = bucket(pid).get(toolUseId);
  if (!r) return null;
  Object.assign(r, patch, { at: Date.now() });
  return r;
}

export function getReservation(pid, toolUseId) {
  const r = pid && toolUseId ? bucket(pid).get(toolUseId) : null;
  if (!r) return null;
  if (Date.now() - r.at > TTL_MS) { bucket(pid).delete(toolUseId); return null; }
  return r;
}

/** 取走（落板后调）：返回并删除 */
export function takeReservation(pid, toolUseId) {
  const r = getReservation(pid, toolUseId);
  if (r) bucket(pid).delete(toolUseId);
  return r;
}

/** 某一层上的预留座，障碍集用（id 跟前端视点上报的直播框同口径：live:<toolUseId>） */
export function reservationsIn(pid, zone = '') {
  const out = [];
  if (!pid || !store.has(pid)) return out;
  const now = Date.now();
  for (const [id, r] of bucket(pid)) {
    if (now - r.at > TTL_MS) { bucket(pid).delete(id); continue; }
    if ((r.zone || '') !== (zone || '')) continue;
    out.push({ id: `live:${id}`, x: r.x, y: r.y, w: r.w, h: r.h });
  }
  return out;
}

export function _resetReservations() { store.clear(); }
