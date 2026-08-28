/**
 * PreToolUse 默认值矫正族 —— 透明改 tool_input，agent 无感，结果更有用。
 * （2026-08-14 可维护性行动：从 hooks.js 原样迁出，语义零改动）
 */

import { isResidentRole, resolveRoleTools } from '../cast.js';
import { readRoleCard } from '../role-card.js';
import { noteToolCaller } from '../actor-trail.js';
import { MCP_SERVER_NAME } from '../../mcp/server-name.js';

/**
 * PreToolUse(Agent) 强制前台 —— 透明改 input，不 hard deny。
 *
 * ⚠️ 2026-08-03 修：**默认值翻了面，这个 hook 之前形同虚设。**
 *
 * 老 SDK：`run_in_background` 不传 = 前台，所以只需拦 `=== true`。
 * 新 SDK（sdk-tools.d.ts AgentInput 原文）："Agents run in the background by
 * default; you will be notified when one completes. **Set to false** to run this
 * agent synchronously when you need its result before continuing."
 *
 * 也就是说**不传 = 后台**。模型自然写法就是不传（探针实测 bg=undefined），于是：
 * 主 agent 只拿到一句 "Async agent launched successfully"，报告永远不回来。
 * 真实事故：2026-08-03 一个 explorer 烧了 38k tokens / 20 次工具调用 / 108 秒查
 * 完时局资料，主 agent 收到的 tool_result 里一个字都没有，只好自己重搜四轮，
 * 还跟用户说了句"研究员跑完了但报告没回传到我这儿"。
 *
 * 所以判据从"等于 true 才改"改成"**不是显式 false 就补 false**"。
 * 显式传了 false 的（模型自己知道要前台）原样放过，不重复改也不发提示。
 *
 * 为什么 NoDesign 一定要前台：创作的核心反馈环是 agent 看 explorer /
 * vision-checker 传回的素材 URL 与 critique → 据此改产物 → 再自检。
 * fire-and-forget 等于把这个环剪断，agent 拿不到结果只能盲写。
 * forwardSubagentText 已开，前台等的时候用户看得见子代理实时进度，不会卡死。
 *
 * 兜底另有一层：DEFAULT_TOOL_ALLOWLIST 里挂了 `TaskOutput`，万一还是漏成后台
 * （比如 isolation:'remote' 强制后台），主 agent 能凭 task_id 把报告捞回来。
 */
/**
 * 这个角色声明的工具合不合法。合法返回 null，不合法返回一句给模型看的原因。
 * 读不到文件时放行 —— 那说明角色压根不存在，派发自己会失败（失败会把名字从名册撤回）。
 */
async function illegalRoleTools(workspaceRoot, slug) {
  if (!workspaceRoot) return null;
  const card = await readRoleCard(workspaceRoot, slug);
  if (!card) return null;
  const decl = card.toolsDecl;

  if (decl.kind === 'missing') {
    return `角色「${slug}」的文件里没有 tools 那一行 —— 那在 SDK 语义里等于**继承你的全部工具**，`
      + `包括外发和花钱的那些。用 cast_role 重新造这个角色（它会写一份只含板上工具的声明）。`;
  }
  if (decl.kind === 'unparsable') {
    return `角色「${slug}」的 tools 声明看不懂，为安全起见不派。用 cast_role 重新造它。`;
  }
  const { rejected } = resolveRoleTools(decl.tools, MCP_SERVER_NAME);
  if (rejected.length) {
    return `角色「${slug}」声明了不该给角色的工具：${rejected.join('、')}。`
      + `角色只能通过画布表达自己 —— 外发、花钱、改工作区结构的工具一律不发给它。`
      + `用 cast_role 重新造它，或把这些工具从它的文件里去掉。`;
  }
  return null;
}

export function makePreToolUseAgentForceForegroundHandler({ roster = null, workspaceRoot = null, ctx = null } = {}) {
  return async (input, toolUseId) => {
    const t = input?.tool_input;
    if (!t || typeof t !== 'object') return {};

    // ── 常驻角色（rp-*）走反方向：强制**后台** + 钉死名字 ──
    //
    // 为什么它跟上面那段的结论相反：干活型子代理的产出是 tool_result 里的报告，
    // 前台等着才拿得到；常驻角色（叙事者 / NPC）的产出走**画布和收件箱**，
    // 它压根没打算结束回合 —— 前台跑等于把整条主线卡在一个不会返回的角色上。
    //
    // 名字必须由 harness 钉，不能指望模型传：2026-08-26 探针里三次明确要求
    // 「name 参数必须写全」，模型三次都省掉了（还振振有词说 schema 里没有）。
    // 没名字就只能用 agentId 寻址，而 agentId 只在那一条 tool_result 里出现过 ——
    // 主代理换个话题就再也叫不回这个角色了。钉成 subagent_type 本身：
    // 一个角色一个常驻实例，寻址名 = 角色名，两边不用对表。
    if (isResidentRole(t.subagent_type)) {
      // 重派同名角色 = 静默失忆：CLI 的 latest wins 让新角色顶掉这个名字，
      // 旧角色连同它演过的全部剧情一起失联，而且不报错。只靠提示词劝拦不住
      // （模型连 name 参数都不肯传），所以这里硬拦，并给出两条真出路。
      // nd:rp-prompt
      // 本回合刚造出来的角色：CLI 要到回合边界才重扫角色目录，这一派必然 not found。
      // 与其让它撞一次错误再谎报"已派"，不如在这里拦住并说清楚怎么办。
      if (roster?.castedInRun?.(t.subagent_type, ctx?.runId)) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            // nd:rp-prompt
            permissionDecisionReason:
              `「${t.subagent_type}」是这一回合刚造出来的，**现在还派不动** —— `
              + `CLI 要到下一条消息才认得新角色。先把手头的话说完、结束这一回合，`
              + `你会收到一条「可以派了」的系统消息，那时再派。不要在这一回合重试，也不要说它已经上场了。`,
          },
        };
      }

      // ⭐ 工具白名单收口在**派发时**，不是写入时。cast_role 是造角色的正门，但主 agent
      // 手里有 Write/Edit/Bash，`.claude/agents/` 就在工作区内 —— 手写一份 md 就能
      // 给自己造一个拿着 publish_site 的"角色"。拦写入拦不干净（Write 拦了还有 Bash，
      // Bash 拦了还有别的落盘路径），拦派发只有这一个口子。
      // 见 role-card.js：缺 tools 行 = SDK 语义上继承父代理的全部工具，所以缺失也不放行。
      const illegal = await illegalRoleTools(workspaceRoot, t.subagent_type);
      if (illegal) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            // nd:rp-prompt
            permissionDecisionReason: illegal,
          },
        };
      }

      if (roster && roster.has(t.subagent_type)) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              `「${t.subagent_type}」已经在场了，不用重新派。要它接着演就用 `
              + `SendMessage 寄给这个名字（它记得之前所有事）。重新派会新起一个失忆的同名角色`
              + `并顶掉现在这个，之前演过的全部剧情都会失联。真要另起一个角色，换个名字。`,
          },
        };
      }
      if (roster) roster.claim(t.subagent_type);
      // ⭐ 派发这次调用的 toolUseId，正是这个角色之后所有事件的 parentToolUseId
      //（SDK 用它标"这条消息来自哪个子代理"）。在这儿盖一次章，画布那边就能
      // 认出"这个事件是墨璃干的"，不用再建第二套映射。见 actor-trail.js
      noteToolCaller(toolUseId || input?.tool_use_id, { agentType: t.subagent_type });
      if (t.run_in_background === true && t.name === t.subagent_type) return {};   // 已经对了，别重复改
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { ...t, run_in_background: true, name: t.subagent_type },
          // nd:rp-prompt —— 这句话是 RP 教义的一部分，等提示词层专门过一遍时一起调
          additionalContext:
            `「${t.subagent_type}」是常驻角色：已按后台派出并把它的名字钉成 ${t.subagent_type}。`
            + `以后要它说话/接着演，用 SendMessage 寄给这个名字（它记得之前所有事），不要重新派一次 —— `
            + `重派会新起一个失忆的同名角色并顶掉旧的。`,
        },
      };
    }

    // 显式前台，不动
    if (t.run_in_background === false) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...t, run_in_background: false },
        // 一句事实就够：为什么要前台 prelude 硬规则里已经讲了，每次派遣重复一遍是 N 倍说教
        additionalContext: '已改为前台执行（run_in_background: false），报告会在这次 tool_result 里回来。',
      },
    };
  };
}

/**
 * PreToolUse(Grep) handler：把缺省 output_mode 改成 'content'。
 *
 * SDK Grep 工具默认 output_mode='files_with_matches' —— 只返回匹配到的文件名
 * 列表，不返回行内容。Agent 拿到文件名后还得再 Read 一遍，多一个 turn，浪费
 * tokens 和时延。NoDesign 设计场景下 agent grep 几乎都是想看实际文本（CSS
 * 类名定义在哪、某个 token 怎么用），'content' 是更合理的默认。
 *
 * 拦截规则：
 *   - 没传 output_mode 或传了空字符串 → updatedInput 改成 'content'
 *   - 显式传 'files_with_matches' / 'count' → 不动（agent 知道自己在做什么）
 *
 * ⚠️ Grep 的输入改写只许有这一个 handler：两个 handler 各返回 updatedInput，
 * 后跑的那个是拿原始 tool_input 拼的，会把前一个的改动抹掉（2026-08-15 演出
 * 隐私闸想在这儿加排除 glob 时踩明白的，那版已按用户决定撤回）。
 *
 * 不发 additionalContext —— agent 不需要知道这个变换，行为对它透明，结果
 * 直接更有用。
 */
export function makePreToolUseGrepContentDefaultHandler() {
  return async (input) => {
    const t = input?.tool_input;
    if (!t || typeof t !== 'object') return {};
    if (t.output_mode && t.output_mode !== '') return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...t, output_mode: 'content' },
      },
    };
  };
}

/**
 * PreToolUse：把「这次工具调用是谁发起的」记下来，给 MCP 工具署名用。
 *
 * MCP handler 拿不到 agent_id / agent_type（extra 里没有），hook 拿得到 —— 这条旁路是
 * 板上归属的唯一可信来源。**不要改成从角色文件读**：那份文件模型能改，自称不是实证。
 * 见 actor-trail.js 的头注释。
 *
 * 挂通配（mcp__nodesign__.*，见 hooks.js）：这里曾按「板上写入类才需要」挂手写名单，
 * 漏过两次（08-26 收件箱三件、08-28 场务四件），每次症状都是 byOf 静默落回 'agent'、
 * 依赖它的守卫整条失效。一次 Map.set 的代价换「凡用 byOf 的工具永远在闸内」，值。
 */
export function makePreToolUseActorStamp() {
  // 具名函数：装配测试（hooks-assembly.test.js）按 fn.name 认出这道闸挂没挂对
  return async function actorStamp(input, toolUseId) {
    noteToolCaller(toolUseId || input?.tool_use_id, {
      agentId: input?.agent_id || null,
      agentType: input?.agent_type || null,
    });
    return {};
  };
}
