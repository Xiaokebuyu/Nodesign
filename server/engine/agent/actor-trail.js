/**
 * engine/agent/actor-trail.js —— 「这次工具调用是谁发起的」（2026-08-26）
 *
 * ## 为什么需要这条路
 *
 * MCP 工具的 handler 拿不到调用者身份：`extra` 里只有 `_meta['claudecode/toolUseId']`、
 * sessionId 那些，没有 agent_id / agent_type（2026-08-26 实测）。而 **hook 拿得到** ——
 * `PreToolUse` 的 input 带 `agent_id` / `agent_type`，第二个参数就是 toolUseId。
 *
 * 所以：hook 在工具执行前把 (toolUseId → 谁) 记下来，MCP handler 用 extra 里的
 * toolUseId 查回去。一条短命的旁路，不改 MCP 协议、不动工具签名。
 *
 * ## 归属的锚为什么必须是这条路，而不是角色文件
 *
 * 角色文件（`.claude/agents/rp-*.md`）**是模型可写的**，里面的展示名是**自称**：
 * 一个角色可以把自己的 description 写成「RP 角色「用户」」，也可以顶替别的角色的名字。
 * 拿它当归属 = 谁都能冒充谁。而 `agent_type` 是 harness 在派发那一刻亲眼所见并盖章的，
 * 模型改不了。**权威是 slug，文件里的展示名只当展示层。**
 *
 * ## 生命周期
 *
 * 一次工具调用的寿命就是它的寿命。留一个上限防跑量（长会话里工具调用成千上万，
 * 不清理就是内存漏），按插入序淘汰最旧的 —— 淘汰掉的最坏后果是那条板书落回
 * 'agent' 署名，不影响正确性。
 */

const MAX = 500;
const trail = new Map();   // toolUseId -> { agentId, agentType }

/** hook 侧：工具执行前盖章 */
export function noteToolCaller(toolUseId, { agentId = null, agentType = null } = {}) {
  if (!toolUseId) return;
  if (!agentId && !agentType) return;              // 主线程调用不必记，查不到就是主 agent
  trail.set(toolUseId, { agentId, agentType });
  if (trail.size > MAX) {
    const oldest = trail.keys().next().value;
    trail.delete(oldest);
  }
}

/** 工具侧：查这次调用是谁 */
export function callerOf(toolUseId) {
  return (toolUseId && trail.get(toolUseId)) || null;
}

/**
 * 演员位实例别名（2026-08-28 重构）：agentId → 实例名（rp-cheng-wan）。
 *
 * ## 为什么需要这张表
 *
 * 同型多实例之后，hook input 里的 `agent_type` 是演员位（rp-actor），**没有实例名
 * 字段**（2026-08-28 探针：SubagentStart/PreToolUse/SubagentStop 三处 keys 全录，
 * 只有 agent_id / agent_type）。而收件箱、名册、板书署名全按实例名走 —— 不桥接的话
 * 所有角色的 byOf 塌成 'rp-actor'，收件箱共用一个坑。
 *
 * ## 学名字的两条路（都在 PostToolUse，见 hooks/slot-alias.js）
 *
 *   派发：Agent 的 tool_result 里有 `agentId: <id>`，tool_input.name 是实例名
 *   唤醒：SendMessage 按名寄的 tool_result 里有 `resumedAgentId` + pin.name
 *
 * 表是会话内存态：服务器重启后角色本来就要重新派（名册同界），别名随新派发重新学。
 * 上限防跑量同 trail —— 淘汰最旧的最坏后果是署名落回 'rp-actor'，不影响正确性。
 */
const agentNames = new Map();   // agentId -> 实例名
export function noteAgentName(agentId, name) {
  if (!agentId || !name) return;
  agentNames.set(String(agentId), String(name));
  if (agentNames.size > MAX) {
    const oldest = agentNames.keys().next().value;
    agentNames.delete(oldest);
  }
}
export function agentNameOf(agentId) {
  return (agentId && agentNames.get(String(agentId))) || null;
}

/**
 * 派发闸认领了名字、还等着跟 agent_id 配对的队列（2026-08-29）。
 *
 * ## 为什么换掉旧桥
 *
 * 旧桥（hooks/slot-alias.js 的派发分支）从 **tool_result 的文本**里正则抠 `agentId:`。
 * 2026-08-28 真会话实录：六条板书里五条署名落成演员位（`rp-narrator`），也就是那条
 * 桥在生产上没接上 —— 而它一断，byOf 就塌回演员位，署名、去向判据、前端点名全认错人。
 *
 * 新桥不解析任何文本：派发闸认领名字时把名字排进队列，`SubagentStart` 那一刻
 * harness 亲手给 `agent_id` + `agent_type`，两边一配就绑定。顺序天然对得上 ——
 * 闸跑在工具执行前，子代理起飞在工具执行后，FIFO 就是派发顺序。
 */
const pendingRoleNames = [];
const PENDING_MAX = 16;

/** 派发闸侧：认领了这个名字，等它起飞 */
export function notePendingRoleName(name) {
  if (!name) return;
  pendingRoleNames.push(String(name));
  // 上限防跑量：派出去却从没起飞的名字（派发失败）会留在队里，超了就丢最旧的。
  // 最坏后果是某个角色的署名落回演员位 —— 跟旧桥断掉时一样，不会更糟。
  if (pendingRoleNames.length > PENDING_MAX) pendingRoleNames.shift();
}

/** SubagentStart 侧：取走队头的名字 */
export function takePendingRoleName() {
  return pendingRoleNames.shift() || null;
}

/** 测试用 */
export function _resetActorTrail() {
  trail.clear(); agentNames.clear(); pendingRoleNames.length = 0;
}
