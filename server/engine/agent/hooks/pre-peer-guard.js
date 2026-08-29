/**
 * hooks/pre-peer-guard.js —— SendMessage 收件人闸（2026-08-26）
 *
 * ## 为什么要有
 *
 * 把 `SendMessage` 挂进 DEFAULT_TOOL_ALLOWLIST（常驻角色的唯一叫醒方式）的同时，
 * 也就打开了这个工具的**另一半寻址空间**：同一台机器上其他 Claude 会话。
 * 2026-08-26 探针实测，`ListAgents` 在这台机器上列出了 4 个 peer session
 * （站主自己的交互会话、tmux 里的、别的项目的），SendMessage 的 `to` 是自由字符串，
 * 猜中一个名字就寄得过去。
 *
 * 对 Nodesign 这是明确不能有的东西：会话属于不同用户，跨会话寄信 =
 * 一个用户的 agent 能给另一个人的 agent 递指令。SDK 侧的 `crossSessionInbound`
 * 只管**收**（我们收不收别人的），管不了**发**。所以发这一侧自己装闸。
 *
 * ## 判据（白名单，不是黑名单）
 *
 * 只放行三种收件人：
 *   1. `main`         —— 子代理跟主代理说话（CLI 保留字，寄到主对话）
 *   2. `rp-*`         —— 本会话的常驻角色（见 cast.js）
 *   3. `a<16 位十六进制>` —— 本会话某个子代理的 agentId（派发时那条 tool_result 给的，
 *                        天生只在本会话内有意义）
 * 其余一律 deny。**黑名单在这里必然漏**：peer session 的名字是别人机器/别人会话
 * 起的，形状不受我们控制，枚举不完。
 *
 * ⚠️ 判据要能被攻：探针 _probe-resident-agent.mjs 里有一条「寄给 peer session 名字
 * 必须被拒」的反向断言 —— 只看"它没放过坏东西"是不够的，得给它一个**按规定必须拦
 * 的东西**看它拦不拦（记忆 feedback-verify-guards-by-attacking）。
 */

/* 判据是「本会话真的派过它」，不是「名字长得像角色」—— 理由见 cast.js 的 createRoleRoster */

/**
 * 本会话子代理的 agentId 形状（派发 tool_result 里的 `agentId: a67e7b9568aa4698b`）。
 * ⚠️ 这是 CLI 2.1.237 的实测形状；SendMessage 的 schema 文档把格式写成 `a...-...`
 * （存在带连字符的变体）。CLI 换版若改长度或加连字符，合法 agentId 会被误拒 ——
 * 方向是过拦、症状可见（deny 会把原因回显给模型），不会静默放行，所以钉死可接受。
 */
const AGENT_ID_RE = /^a[0-9a-f]{16}$/;

/** CLI 保留字：寄到主对话 */
const MAIN = 'main';

export function makePreToolUseSendMessageRecipientGuard({ roster = null } = {}) {
  return async (input) => {
    const to = input?.tool_input?.to;
    // 形状不对也拒：白名单闸的缺省必须是拒。真 schema 里 `to` 是 string 且
    // additionalProperties:false，所以今天走不到这里 —— 但那是**CLI 版本事实**，
    // 不是我们的不变量，翻成 deny 零成本。
    if (typeof to !== 'string') return deny(String(to));
    const target = to.trim();

    // 闸判的是 trim 后的值，工具收到的是原值 —— 两个字符串不一致就是两套判据。
    // allow 时顺手回写（SendMessage matcher 下只有这一个 handler，不踩 updatedInput 互抹的坑）。
    const pass = () => (target === to ? {} : {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...input.tool_input, to: target },
      },
    });

    if (target === MAIN || AGENT_ID_RE.test(target)) return pass();
    // ⭐ 关键：问名册「这个角色是不是本会话派的」，不是问名字长得像不像。
    // 形状判据会把裸名放给 CLI 去全机器解析，本会话没有同名 agent 时它会落到
    // 别人的会话上（多用户共机 + 统一命名教义 = 必然撞名）。
    // 没接名册时**不退回形状判据**：那是静默降级（闸看起来还在，判据已经换成不安全的那个）。
    // 漏接线的症状必须是「角色寄不出信」这种看得见的坏，不是悄悄放宽。
    if (roster?.has(target)) return pass();

    return deny(target);
  };
}

function deny(target) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      // nd:rp-prompt —— 拒绝话术属于 RP 教义，等提示词层专门过时一起调
      permissionDecisionReason:
        `收件人「${target}」不在本会话里。SendMessage 只能寄给：main（主对话）、`
        + `本会话已经派出的常驻角色、或本会话子代理的 agentId（形如 a1234567890abcdef，`
        + `裸 id 不要带 [ref] 后缀）。这台机器上可能有别人的会话，跨会话寄信一律不放行；`
        + `角色如果还没派出来（比如服务重启过），先派它，不要直接寄信。`,
    },
  };
}
