/**
 * server/lib/sheet-state.js —— 「当前纸」的会话指针（2026-08-29 纸范式）
 *
 * 每个会话记一张「正写在哪张纸上」。进程内存不落盘：丢了也无害 —— 读侧回落到
 * 登记时间最新的一张（board-sheets.js currentSheet 的兜底），agent 重新铺纸或
 * 点名纸名都能续上。放 board.json 是错的：两个会话同时开工会互相抢指针。
 */

const cur = new Map();   // sessionId → sheet name

export function setCurrentSheetId(sessionId, id) {
  if (sessionId && typeof id === 'string') cur.set(sessionId, id);
}

export function currentSheetIdOf(sessionId) {
  return (sessionId && cur.get(sessionId)) || null;
}

export function _resetSheetState() { cur.clear(); }
