/**
 * hooks/post-loop-guard.js —— 同一工具连调 N 次的循环检测（2026-09-08 诊断埋点⑩）。
 *
 * 当天的案子：GLM 在一个会话里连搜七次 ToolSearch（每次换个词），因为转换层把结果丢空了。那种循环
 * 在会话记录里一眼能看见，但没有任何机制在**当时**拦它。这里挂在 PostToolUse：每会话记「上一个工具名
 * 与连调次数」，同一个工具**连续**（中间没有别的工具）调到第 N 次：
 *   - 记一条 auto 问题（signature 按 会话+工具 归并，同一循环只记一条）
 *   - 给 agent 一句 additionalContext：停下来换办法或问用户
 * 只看名字不看参数：参数相似度判不准（Read 十个不同文件也是连调），阈值取 6 —— 正常工作流里同一工具
 * 连调 6 次以上（Read×6 也算）本来就该停一下想想。
 */
import { recordIssue } from '../../../lib/issues-store.js';

export const LOOP_THRESHOLD = 6;

export function makePostToolUseLoopGuard({ projectId, sessionId, threshold = LOOP_THRESHOLD, record = recordIssue } = {}) {
  let lastTool = null;
  let run = 0;
  let warnedAt = 0;
  return async (input) => {
    const tool = input?.tool_name || null;
    if (!tool) return {};
    if (tool === lastTool) run += 1; else { lastTool = tool; run = 1; warnedAt = 0; }
    if (run < threshold || warnedAt === run) return {};
    // 第 N 次、以及之后每再连调 N 次提醒一次（6、12、18…），中间不刷屏
    if ((run - threshold) % threshold !== 0) return {};
    warnedAt = run;
    try {
      record({
        source: 'auto', kind: 'friction', toolName: tool,
        summary: `${tool} 连续调用 ${run} 次（循环检测）`,
        detail: `会话 ${String(sessionId || '').slice(0, 8)} 里 ${tool} 连续调用 ${run} 次，中间没有别的工具。`,
        signature: `loop|${sessionId || ''}|${tool}`, projectId, sessionId,
      });
    } catch { /* 记账失败不影响 agent */ }
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `[循环提醒] 你已经连续 ${run} 次调用 ${tool}。如果前几次没拿到想要的结果，再来一次多半也不会：换一个办法，或者把卡点告诉用户。`,
      },
    };
  };
}
