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

import { isResidentRole } from '../cast.js';

export function makePostToolUseFailureRoleRelease({ roster = null } = {}) {
  return async (input) => {
    if (!roster) return {};
    const type = input?.tool_input?.subagent_type;
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
