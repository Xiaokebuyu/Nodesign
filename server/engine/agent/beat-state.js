/**
 * engine/agent/beat-state.js —— 「这一拍收完了吗」（2026-08-29）
 *
 * ## 它拦的事故
 *
 * 08-28 真会话（proj_mtcyfdls）诊断出来的头号病：主持人写完两千字正文就收工，
 * 玩家面前没有任何把手，只能自己打出「接下来该怎么办」——那句话本身就是漏拍的信号。
 * 这条教义在提示词里写了整整一节，模型照旧漏。这条线的老账：**写成话术它不听，
 * 写成闸它才听**。
 *
 * ## 判据（保守，宁可漏拦不可错拦）
 *
 * 这一轮里主持人往画布上写过东西，却**既没给按钮、也没把这一拍交给任何角色** ——
 * 那这一拍确实停在半空。三个信号都是服务端亲眼所见的工具调用，不是模型的自述：
 *
 *   写过    write_on_board / board_batch（且调用者是主持人，不是角色）
 *   给了按钮 同一批调用的正文里出现 nd:controls 围栏
 *   交出去了 Agent 派角色 / SendMessage 寄给角色
 *
 * 只拦**第一次** Stop（`stop_hook_active` 为真说明已经拦过一轮，再拦就是死循环）。
 *
 * 状态跟会话走，每轮开头（UserPromptSubmit）清一次 —— 判的是「这一轮」，不是历史。
 */

const beats = new Map();   // sessionId → { wrote, controls, handed }

function slot(sessionId) {
  if (!beats.has(sessionId)) beats.set(sessionId, { wrote: false, controls: false, handed: false });
  return beats.get(sessionId);
}

/** 主持人往画布上写了东西。hasControls = 这次的正文里有 nd:controls 围栏 */
export function noteBeatWrite(sessionId, hasControls) {
  if (!sessionId) return;
  const s = slot(sessionId);
  s.wrote = true;
  if (hasControls) s.controls = true;
}

/** 这一拍交给角色了（派它上场 / 寄话给它） */
export function noteBeatHandoff(sessionId) {
  if (!sessionId) return;
  slot(sessionId).handed = true;
}

/** 新的一轮开始，重新记 */
export function resetBeat(sessionId) {
  if (sessionId) beats.delete(sessionId);
}

/** 这一拍是不是停在半空（写了正文，既没按钮也没交给谁） */
export function beatLeftHanging(sessionId) {
  const s = beats.get(sessionId);
  return !!s && s.wrote && !s.controls && !s.handed;
}

/** 会话收摊 */
export function clearBeatState(sessionId) { beats.delete(sessionId); }

/** 测试用 */
export function _resetBeatState() { beats.clear(); }
