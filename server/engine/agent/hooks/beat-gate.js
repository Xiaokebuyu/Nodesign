/**
 * hooks/beat-gate.js —— 这一拍没收完就别收工（2026-08-29）
 *
 * 判据与理由见 engine/agent/beat-state.js。这里只做三件接线：
 *
 *   PostToolUse(write_on_board|board_batch)  主持人写了 → 记一笔，顺带看有没有按钮
 *   PostToolUse(Agent|SendMessage)           这一拍交给角色了 → 记一笔
 *   Stop                                     两样都没有就 block 一次，把话说清楚
 *
 * ⚠️ 只认**主持人自己**的写入：角色写的板书不算「这一拍收完了」——它写完正是主持人
 * 该收尾的时候。判据用 hook input 的 `agent_id`（子代理调用才有，harness 盖的章）。
 */

import { noteBeatWrite, noteBeatHandoff, beatLeftHanging, resetBeat } from '../beat-state.js';
import { isRpProject } from '../rp-mode.js';
import { isResidentRole } from '../cast.js';

const CONTROLS_RE = /nd:controls/;

/** 从 write_on_board / board_batch 的入参里捞出所有正文 */
function textsOf(input) {
  const t = input?.tool_input;
  if (!t || typeof t !== 'object') return [];
  const out = [];
  if (typeof t.text === 'string') out.push(t.text);
  for (const op of Array.isArray(t.ops) ? t.ops : []) {
    if (op && typeof op.text === 'string') out.push(op.text);
  }
  return out;
}

export function makePostToolUseBeatWrite({ sessionId = null, projectId = null } = {}) {
  return async function beatWrite(input) {
    if (!isRpProject(projectId)) return {};
    if (input?.agent_id) return {};                    // 角色写的不算
    const texts = textsOf(input);
    if (!texts.length) return {};
    noteBeatWrite(sessionId, texts.some((x) => CONTROLS_RE.test(x)));
    return {};
  };
}

export function makePostToolUseBeatHandoff({ sessionId = null, projectId = null } = {}) {
  return async function beatHandoff(input) {
    if (!isRpProject(projectId)) return {};
    const t = input?.tool_input;
    const to = typeof t?.to === 'string' ? t.to : null;
    const name = typeof t?.name === 'string' ? t.name : null;
    // Agent 派角色（name 是实例名）或 SendMessage 寄给角色，都算把这一拍交出去了
    if (isResidentRole(to) || isResidentRole(name) || t?.subagent_type) noteBeatHandoff(sessionId);
    return {};
  };
}

/** nd:rp-prompt —— 拦下来时对主持人说的话 */
export const BEAT_HANGING_REASON =
  '这一拍还停在半空：你往画布上写了东西，但没给玩家一个可按的下一步。'
  + '在这一拍下面补一条 ```nd:controls``` 围栏再收工 —— 两到四枚选项'
  + '（一枚推进主线、一枚人际、一枚剑走偏锋），再留一句「想干别的直接在画布上标注」。\n'
  + '（这一版角色子代理停用，台上所有人都由你写完 —— 别拿「交给角色」当这一拍的出口。）\n'
  + '（纯粹的场记维护 —— 只更新状态板、只理版面 —— 不受这条约束：'
  + '那种情况下你本来也没写新的一拍。）';

export function makeStopBeatGate({ sessionId = null, projectId = null } = {}) {
  return async function beatGate(input) {
    if (!isRpProject(projectId)) return {};
    // 已经拦过一轮就放行：再拦是死循环，而且模型此刻正在照着做
    if (input?.stop_hook_active) { resetBeat(sessionId); return {}; }
    if (!beatLeftHanging(sessionId)) { resetBeat(sessionId); return {}; }
    resetBeat(sessionId);
    return { decision: 'block', reason: BEAT_HANGING_REASON };
  };
}
