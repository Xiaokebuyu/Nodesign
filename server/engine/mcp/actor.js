/**
 * engine/mcp/actor.js —— 板上写入的署名（2026-08-26）
 *
 * 板上每一样东西都带 `by`。在常驻角色之前它只有两个值（'agent' / 'user'），
 * 现在多了第三类：**具名角色**（叙事者、NPC），值是它的 slug（`rp-moli`）。
 *
 * 为什么署 slug 而不署展示名：slug 是 harness 在派发那一刻盖的章（见 actor-trail.js），
 * 展示名住在角色文件里、而那个文件模型能改。署名要能当证据用，就不能取自被署名者
 * 自己写的文本。展示名由读侧按 slug 查出来（role-card.js），查不到就显示 slug 本身。
 */

import { callerOf, agentNameOf } from '../agent/actor-trail.js';
import { isResidentRole, isSlotType, safeRoleLabel } from '../agent/cast.js';

/** MCP handler 的 extra 里取本次 tool_use id（2026-08-26 实测就在这个键上） */
export function toolUseIdOf(extra) {
  return extra?._meta?.['claudecode/toolUseId'] || null;
}

/**
 * 这次板上写入该署谁的名。
 * @returns {'agent'|string}  主 agent → 'agent'；常驻角色 → 它的 slug
 */
export function byOf(extra) {
  const caller = callerOf(toolUseIdOf(extra));
  const type = caller?.agentType;
  // 落到**演员位**（rp-actor/rp-narrator）说明盖章那一刻别名还没学到实例名。
  // 这里**当场再解一次** —— 别名可能在盖章之后才学到（08-28 真会话实录：
  // 19:59 派发、20:10 角色调 jot_memory 被拒、20:10 GM 一发 SendMessage 别名补上、
  // 20:21 同一个工具就成了。差的就是"用盖章那一刻的快照"还是"用此刻的表"）。
  if (isSlotType(type)) {
    const nm = agentNameOf(caller?.agentId);
    if (isResidentRole(nm) && !isSlotType(nm)) return nm;
  }
  return isResidentRole(type) ? type : 'agent';
}

/**
 * 把一个 `by` 渲染成给**这个读者**看的称呼。
 *
 * read_board 的输出可能被主 agent 读，也可能被角色自己读 —— 同一句「你写的」对两个
 * 读者含义相反。所以渲染要带视角：谁在读，就管谁叫「你」。
 *
 * @param by         板上那条东西的署名（'user' / 'agent' / 'rp-*'）
 * @param viewer     当前读者（同上取值）
 * @param names      slug → 展示名（只当展示层，见 role-card.listRoleNames）
 */
export function describeBy(by, viewer, names) {
  if (by === viewer) return '你';
  if (by === 'user') return '用户';
  if (by === 'agent') return '主控';
  return safeRoleLabel(by, names?.get?.(by));
}

/**
 * 保留字的第二道防线。真正的闸在源头（`listRoleNames` 出口，见 cast.js
 * `safeRoleLabel` 的注释）；这里留一层是给「名字没经过那条路」的调用点兜底。
 */
export { safeRoleLabel as roleLabel } from '../agent/cast.js';
