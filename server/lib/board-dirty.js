/**
 * server/lib/board-dirty.js —— 板上动静（2026-08-29 纸范式刀 4）
 *
 * 病根：用户拖拽落盘（HTTP PATCH /board）与文件搬家（POST /move）此前**完全静默**
 * —— board.updated 七处 emit 全是 agent 侧动作，agent 对「用户刚动过什么」只能等
 * 下一轮注入撞运气。这里立一份进程内的动静台账：
 *
 *   写方   api/board.js PATCH（位置真变了才记 —— 尺寸回写不算动静）、
 *          api/board.js erase、api/assets.js /move
 *   读方   UserPromptSubmit「板上动静」节（下轮必达）、
 *          PreToolUse 板工具注入器（agent 下一次摸板时插话，按会话恰好一次）
 *
 * HTTP 层就是用户（agent 侧写板走 board-store 直调不过这里），所以不用猜作者。
 * 进程内存不落盘：动静是「此刻」，重启即作废。
 */

const CAP = 60;
const TTL_MS = 30 * 60 * 1000;
let seq = 0;                 // 单调序号（同毫秒两笔动静时间戳会撞车，序号不会）
const store = new Map();     // pid → [{seq, at, kind, id, to?}]
const markers = new Map();   // `${pid}:${sessionId}` → 上次已告知的序号

function prune(list, now) {
  const keep = list.filter(e => now - e.at <= TTL_MS);
  return keep.length > CAP ? keep.slice(keep.length - CAP) : keep;
}

/** 记一批动静。kind ∈ moved | removed | mv（文件搬家，带 to）| erased（整组擦） */
export function noteBoardDirty(pid, events) {
  if (!pid || !events?.length) return;
  const now = Date.now();
  const list = store.get(pid) || [];
  for (const e of events) {
    if (!e || typeof e.id !== 'string') continue;
    list.push({ seq: ++seq, at: now, kind: e.kind || 'moved', id: e.id.slice(0, 300), ...(e.to ? { to: String(e.to).slice(0, 300) } : {}) });
  }
  store.set(pid, prune(list, now));
}

/** 某序号之后的动静（新在后）。sinceSeq=0 = 全部未过期的 */
export function dirtyEvents(pid, sinceSeq = 0) {
  const now = Date.now();
  const list = prune(store.get(pid) || [], now);
  store.set(pid, list);
  return list.filter(e => e.seq > sinceSeq);
}

export function lastSeen(pid, sessionId) {
  return markers.get(`${pid}:${sessionId}`) || 0;
}

export function markSeen(pid, sessionId, seenSeq = seq) {
  if (pid && sessionId) markers.set(`${pid}:${sessionId}`, seenSeq);
}

/**
 * 有限负责制（刀⑤ 2026-08-30，站主原话改的）：agent 只对**自己专注的工作区**
 * （当前纸的内部）的摆放负责 —— 挪进当前纸的东西点名出来、要它处理；挪出纸面
 * 的是用户自留地，只报不催。板整个是「用户随便动、agent 别拔河」，这条只是把
 * 「动到哪儿了」按纸分拣，agent 才知道哪些动静该接手。
 *
 * @param events   dirtyEvents 的产物
 * @param board    现在的板（位置以现状为准，不看动静发生时的旧坐标）
 * @param sheetOf  (id) => sheetId|null —— 由调用方绑好 board 的判定函数
 * @param currentSheetId  agent 此刻的当前纸
 * @returns {{ inMine: string[], elsewhere: string[] }}  两拨 id
 */
export function splitDirtyByCharge(events, { sheetOf, currentSheetId } = {}) {
  const inMine = []; const elsewhere = [];
  const seen = new Set();
  for (const e of events) {
    if (e.kind === 'erased' || seen.has(e.id)) continue;
    seen.add(e.id);
    const sid = sheetOf ? sheetOf(e.kind === 'mv' ? (e.to || e.id) : e.id) : null;
    (currentSheetId && sid === currentSheetId ? inMine : elsewhere).push(e.id);
  }
  return { inMine, elsewhere };
}

/** 一批动静的人话（注入两处共用一份措辞） */
export function describeDirty(events, { limit = 6 } = {}) {
  if (!events?.length) return null;
  const verbs = { moved: '挪了', removed: '从板上移走了', mv: '把文件搬到', erased: '擦掉了整组' };
  const lines = events.slice(-limit).map((e) => {
    if (e.kind === 'mv') return `${verbs.mv} ${e.to}（原 ${e.id}）`;
    if (e.kind === 'erased') return `${verbs.erased} #${e.id}`;
    return `${verbs[e.kind] || '动了'} ${e.id}`;
  });
  const more = events.length > limit ? `（还有 ${events.length - limit} 条更早的）` : '';
  return `${lines.join('；')}${more}`;
}

export function _resetBoardDirty() { store.clear(); markers.clear(); }
