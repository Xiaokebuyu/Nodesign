/**
 * hooks/resident-role-lifecycle.js —— 常驻角色名册的退场那一侧（2026-08-26）
 *
 * 进场在 `pre-defaults.js`（PreToolUse 的 rp 分支 `roster.claim()`），退场在这里。
 * 两边分开是因为事件族不同，不是因为职责不同 —— 改任何一边都要看另一边。
 *
 * ## 为什么必须有退场
 *
 * claim 发生在 **Agent 工具执行之前**（PreToolUse）。派发要是失败了（最现实的路径：
 * 模型在角色的 `.claude/agents/<name>.md` 写出来之前就先派了这个还不存在的类型），
 * 名字已经登记进名册，而进程里根本没有这个 agent。后果两条，都很迷惑：
 *
 *   1. **收件人闸的洞在这个窄窗口里重开**：闸看名册说「在场」→ 放行 → 而本会话没有
 *      同名 in-process agent → CLI 的裸名解析回落到**全机范围** → 信可能落到别人的会话。
 *      （这正是 H1 的病，名册修好了主干，这里是它的补角。）
 *   2. **这个名字整个会话被 brick**：重派被硬 deny 且文案谎报「已经在场了」，
 *      SendMessage 又叫不醒，模型只剩换名一条路。
 *
 * claim 留在 PreToolUse 不动（它挡住了同一回合并发派两次同名的竞态，这点比挪到
 * PostToolUse 更值），失败时在这里补一次 release —— 进场乐观、退场兜底。
 */

import { isResidentRole, isSlotType } from '../cast.js';
import { agentNameOf, noteAgentName, takePendingRoleName } from '../actor-trail.js';
import { noteRoleStart, noteRoleFinish } from '../stage-status.js';

/**
 * SubagentStart：把这个 agent_id 认成刚派出去的那个角色（2026-08-29）。
 *
 * hook input 只有 `agent_id` + `agent_type`（演员位），没有实例名 —— 名字在派发闸
 * 那一刻就知道了，所以闸把它排进队列（actor-trail.notePendingRoleName），这里取队头
 * 配对。**这是署名的正门**：harness 在起飞那一刻亲手给的 id，不解析任何模型可写的文本。
 *
 * 只认演员位起飞：干活型子代理（vision-checker 那类）不进别名表。
 */
export function makeSubagentStartRoleAlias({ projectId = null } = {}) {
  return async function subagentStartRoleAlias(input) {
    if (!isSlotType(input?.agent_type) || !input?.agent_id) return {};
    const known = agentNameOf(input.agent_id);        // 已经认过（唤醒重入）
    const name = known || takePendingRoleName();
    if (!name) return {};
    if (!known) noteAgentName(input.agent_id, name);
    noteRoleStart(projectId, name);                  // 台上一览：它开始写了
    return {};
  };
}

export function makePostToolUseFailureRoleRelease({ roster = null } = {}) {
  return async (input) => {
    if (!roster) return {};
    // 演员位派发失败：登记的是实例名（tool_input.name），撤的也是它
    const type = isSlotType(input?.tool_input?.subagent_type)
      ? input?.tool_input?.name
      : input?.tool_input?.subagent_type;
    if (!isResidentRole(type)) return {};
    if (!roster.release(type)) return {};

    // 「还没拾取到」跟「角色不存在」是两回事，指引也不同。前者**必须原样重派**，
    // 而模型不会自己这么做：2026-08-26 探针里它撞了 not found 之后既没重试，
    // 还回了一句「已派」谎报成功 —— 所以这句话要说得比"你可以再派一次"硬。
    const notFound = /not found/i.test(String(input?.error || ''));
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUseFailure',
        // nd:rp-prompt
        additionalContext: notFound
          ? `「${type}」没派出来：CLI 还没拾取到它的角色文件（监视器有几秒防抖）。`
          + `**原样再派一次**，别改参数、别跳过、更不要说"已派"—— 它现在还没上场。`
          : `「${type}」没派出来，已经把这个名字从在场名册里撤了 —— 你可以再派一次。`
          + `（如果是因为这个角色还不存在，先用 cast_role 把它的角色文件写出来。）`,
      },
    };
  };
}

/**
 * SubagentStop：角色收笔了，记一笔进台上一览（2026-08-26 建；08-29 改写）。
 *
 * 08-29 之前这里做两件事：标「散场」+ 用 systemMessage 教主控怎么召回。两件都随
 * 常驻/散场概念一起退役 —— 新回路里角色本来就写一段结束一轮，「结束」是正常节拍
 * 不是事故。而且 systemMessage 这条路 08-28 真会话里查无痕迹（SDK 的 SubagentStop
 * 只有 additionalContext，且按类型定义那是**发给子代理**的），主持人真正收到的是
 * SDK 自带的 task-notification。所以这里不再试图跟主持人说话，只记账 ——
 * 状态由每回合状态块的「台上」一节统一注入（user-prompt-submit.js）。
 *
 * ⛔ **不 release 名字**：角色收笔 ≠ 不存在了。它的转录还在，SendMessage 叫得回来；
 * 把名字放回去等于允许重派，而重派会新起一个失忆的同名角色顶掉它。
 */
export function makeSubagentStopRoleNotice({ projectId = null } = {}) {
  return async (input) => {
    // 角色位实例：agent_type 是位置（rp-role），实例名走别名表。别名没学到就跳过
    // （不知道是谁收的笔 —— 别把 'rp-role' 当角色记进台上一览）。
    const name = isSlotType(input?.agent_type)
      ? agentNameOf(input?.agent_id)
      : input?.agent_type;
    if (!name || !isResidentRole(name) || isSlotType(name)) return {};
    noteRoleFinish(projectId, name, input?.last_assistant_message || null);
    return {};
  };
}
