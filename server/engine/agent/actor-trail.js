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

/** 测试用 */
export function _resetActorTrail() { trail.clear(); }
