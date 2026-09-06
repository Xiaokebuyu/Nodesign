/**
 * PostToolUseFailure handler — 工具失败时给 agent 恢复建议。
 * （2026-08-14 可维护性行动：从 hooks.js 原样迁出，语义零改动）
 *
 * input: PostToolUseFailureHookInput (sdk.d.ts:1908)
 *   - tool_name: string
 *   - tool_input: unknown
 *   - tool_use_id: string
 *   - error: string
 *   - is_interrupt?: boolean
 *   - duration_ms?: number
 *
 * output: PostToolUseFailureHookSpecificOutput (sdk.d.ts:1921)
 *   - additionalContext?: string
 */
import { Events } from '../events.js';
import { recordIssue, signatureOf } from '../../../lib/issues-store.js';

export function makePostToolUseFailureHandler({ ctx, projectId, sessionId }) {
  return async (input, _toolUseId, _options) => {
    const tool = input?.tool_name || 'unknown';
    const error = String(input?.error || '').slice(0, 500);
    const isInterrupt = Boolean(input?.is_interrupt);

    try {
      ctx.emit(Events.toolFailure(tool, error));
    } catch { /* ignore */ }

    // is_interrupt: 用户中断 → 不注入建议（agent 应该停下，不是恢复）
    if (isInterrupt) return {};

    // 自动层问题记录（2026-07-30）：每次真失败按"错误类"累加计数。
    // 这层不依赖 agent 自觉 —— 它太会兜底了，工具坏了换个姿势就绕过去，
    // 表面上活儿还是干完的，于是"某个工具本周失败 40 次"没人知道。
    // fail-soft：记录本身绝不能变成新的故障源。
    try {
      // Bash 把命令带进 detail（不进指纹）：exit 144 那类静默死的命令，detail 里
      // 只有一句 "Exit code N"，事后连是谁死的都考证不了（08-24 案，转录已清）
      const cmd = tool === 'Bash' ? String(input?.tool_input?.command || '').slice(0, 300) : '';
      recordIssue({
        source: 'auto',
        toolName: tool,
        summary: `${tool} 失败：${error.slice(0, 120)}`,
        detail: cmd ? `${error}\n[cmd] ${cmd}` : error,
        projectId,
        sessionId,
        signature: signatureOf(`${tool}|${error}`),
      });
    } catch { /* ignore */ }

    let advice;
    if (tool === 'mcp__nodesign__screenshot_canvas') {
      advice =
        '截图失败。常见原因：\n'
        + '  1. 产物文件还没创建 → 先 Write 创建首版\n'
        + '  2. playwright spawn 慢 / 失败 → 换 Read 产物文件让用户看代码\n'
        + '  3. fullPage 截图太大 → 换 fullPage:false 截视口';
    } else if (tool === 'Bash' && /apply-seccomp|unshare\(CLONE_NEWUSER\)/.test(error)) {
      // 沙盒启动自身的偶发（2026-08-15 实测约 1-2/14）：seccomp 那步的 unshare
      // 跟运行时起线程抢跑，EINVAL。跟命令本身、跟权限都没关系 —— **原样重跑
      // 一次就过**。必须点破：08-15 真会话里 agent 把它误判成"隔离闸拦住了"，
      // 拿一个假结论去回答用户。
      // 上游 issue：https://github.com/anthropics/claude-code/issues/86928
      // 现在 ops/sandbox-shim/bwrap 那个垫片已经把它治住了，这条留着兜底：
      // 垫片靠识别 SDK 内部命令前缀工作，SDK 升级后失配就会静默退回偶发。
      advice =
        '这不是你的命令有问题，也不是权限拦截 —— 是沙盒启动时的已知偶发'
        + '（apply-seccomp / unshare EINVAL，约十几分之一的概率）。\n'
        + '**把刚才那条命令原样再跑一次就行**，别改写命令，也别据此推断"某个东西被拦了"。';
    } else if (tool === 'Bash') {
      advice =
        'Bash 命令失败。常见：\n'
        + '  1. sandbox 拦截（命令访问越界文件 / 不允许的网络）→ 换 Read / Glob / Grep / MCP 工具\n'
        + '  2. cwd 越界 → 路径相对 workspace\n'
        + '  3. 命令本身错（参数 / 文件不存在）→ 检查 stderr';
    } else if (/_batch$/.test(tool)) {
      // batch 一步失败整批标错，但失败步之前的动作（click / type 这类非幂等的）
      // **已经执行过了** —— 兜底那句"先重试 1 次"对 batch 是错的，会重放前面的步骤。
      advice =
        `${tool} 失败：${error.slice(0, 200)}\n`
        + '返回文本第一行标了失败在第几步。**不要整批重跑** —— 失败步之前的动作已经执行过了；\n'
        + '看当前状态（返回末尾的截图），只从失败那一步起继续（单独调用或开一个新 batch）。';
    } else if (tool === 'Write' || tool === 'Edit') {
      advice =
        `${tool} 失败。检查：\n`
        + '  1. 路径相对 workspace 还是绝对路径\n'
        + '  2. Edit 的 old_string 是否完整匹配（含空格/缩进）\n'
        + '  3. 文件是否存在（不存在用 Write 创建）';
    } else if (tool === 'Read') {
      advice = `Read 失败：${error}\n  1. 确认路径相对 workspace\n  2. 用 Glob 找文件确认存在`;
    } else if (tool === 'mcp__nodesign__generate_image') {
      // 按错因分流恢复建议（多数 generate_image 失败可恢复，**默认应重试不是放弃**）
      const errLower = error.toLowerCase();
      let cause;
      if (/http 429|rate.?limit|too many request/.test(errLower)) {
        cause = '网关限流（429）→ 等 3-5 秒**直接重试**，不必改 prompt。短时间内连续生图触发的，过会儿就 OK';
      } else if (/http 5\d\d|timeout|gateway|econnreset|socket/.test(errLower)) {
        cause = '网关 / 上游临时故障（5xx / 网络抖动）→ **直接重试 1-2 次**，多数情况下第二次就成；连续 3 次同错才考虑改思路';
      } else if (/no parts|no image|safety|blocked|policy/.test(errLower)) {
        cause = '模型拒生（安全过滤 / 内容策略）→ 调 prompt：换更具体的视觉词（流派 / 镜头 / 灯光），去掉可能触发安全过滤的人物 / 暴力 / 品牌侵权描述，重试';
      } else if (/http 400|invalid|bad request/.test(errLower)) {
        cause = 'Prompt 或参数问题（400）→ 检查：去掉否定描述（"no cars" → "empty street"）/ 加风格锚（"Saul Bass minimalist" / "Fujifilm color science"）/ 参考图张数（1-2 张最稳），重试';
      } else if (/path|reference|enoent|not.?found/.test(errLower)) {
        cause = 'referenceImages 路径错 → 用 Glob 确认文件存在；只接 workspace 相对路径（assets/...），不接 http url；选 1-2 张最切题的不要全 14 张';
      } else if (/quota|budget|limit/.test(errLower)) {
        cause = '配额 / 预算限制 → 看 PM2 日志确认；非紧急情况下告诉用户，等用户决定';
      } else {
        cause = '错因未知 → **先重试 1 次**（多数是网络抖动）；同错重现再调 prompt 关键参数（5 元素公式 / 风格锚 / 文字带引号）。不要第一次失败就放弃';
      }
      advice =
        `generate_image 失败：${error}\n\n`
        + `→ ${cause}\n\n`
        + `**重要**：generate_image 多数失败是可恢复的（网关抖动 / prompt 微调）。第一次失败就放弃 = 用户没图用，跟"agent 不会生图"体感一样差。**默认应重试 1-2 次**，连续 3 次同错才考虑换思路 / 询问用户。`;
    } else {
      advice =
        `${tool} 失败：${error}\n`
        + '常见恢复：\n'
        + '  1. 先重试 1 次（网络抖动 / 临时上游故障多数情况下二次成功）\n'
        + '  2. 同错重现 → 分析错因调整参数 / 换工具\n'
        + '  3. 仅当连续失败且阻塞主线 → 在 chat 里跟用户说当前卡点 + 你打算怎么绕过';
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUseFailure',
        additionalContext: `[工具失败恢复建议]\n${advice}`,
      },
    };
  };
}
