/**
 * hooks/post-loop-guard.js —— 同一工具连调 N 轮的循环检测（2026-09-08 诊断埋点⑩；09-13 改按轮数）。
 *
 * 当天的案子：GLM 在一个会话里连搜七次 ToolSearch（每次换个词），因为转换层把结果丢空了。那种循环
 * 在会话记录里一眼能看见，但没有任何机制在**当时**拦它。每会话记「上一轮只调了哪个工具与连续轮数」，
 * 同一个工具**连续**（中间没有别的工具）调到第 N 轮：
 *   - 记一条 auto 问题（signature 按 会话+工具 归并，同一循环只记一条）
 *   - 给 agent 一句 additionalContext：停下来换办法或问用户
 * 只看名字不看参数：参数相似度判不准（Read 十个不同文件也是连调），阈值取 6 —— 正常工作流里同一工具
 * 连调 6 轮以上（Read×6 也算）本来就该停一下想想。
 *
 * ⛔ 09-13 从 PostToolUse 挪到 PostToolBatch，按「轮」（一条助手消息）数，不按「次」数：
 * 并行工具扩表后 prompt 鼓励把互不依赖的调用放进同一条消息（6 个角度的搜索、6 张图、6 页截图）。
 * 挂在 PostToolUse 时这种一轮就满 6 次，会收到「前几次没拿到想要的结果」—— 话是错的，还会劝停正常的并行。
 * 一轮里只有一个工具名才算这个工具的一轮；一轮里混了别的工具 = 中间有别的工具，清零。
 */
import { recordIssue } from '../../../lib/issues-store.js';

export const LOOP_THRESHOLD = 6;

export function makePostToolBatchLoopGuard({ projectId, sessionId, threshold = LOOP_THRESHOLD, record = recordIssue } = {}) {
  let lastTool = null;
  let run = 0;
  let warnedAt = 0;
  return async (input) => {
    const names = [...new Set((input?.tool_calls || []).map((c) => c?.tool_name).filter(Boolean))];
    if (!names.length) return {};
    if (names.length > 1) { lastTool = null; run = 0; warnedAt = 0; return {}; }
    const [tool] = names;
    if (tool === lastTool) run += 1; else { lastTool = tool; run = 1; warnedAt = 0; }
    if (run < threshold || warnedAt === run) return {};
    // 第 N 轮、以及之后每再连调 N 轮提醒一次（6、12、18…），中间不刷屏
    if ((run - threshold) % threshold !== 0) return {};
    warnedAt = run;
    try {
      record({
        source: 'auto', kind: 'friction', toolName: tool,
        summary: `${tool} 连续调用 ${run} 轮（循环检测）`,
        detail: `会话 ${String(sessionId || '').slice(0, 8)} 里 ${tool} 连续 ${run} 轮调用，中间没有别的工具。`,
        signature: `loop|${sessionId || ''}|${tool}`, projectId, sessionId,
      });
    } catch { /* 记账失败不影响 agent */ }
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolBatch',
        additionalContext: `[循环提醒] 你已经连续 ${run} 轮调用 ${tool}，中间没有用过别的工具。如果前几轮没拿到想要的结果，再来一轮多半也不会：换一个办法，或者把卡点告诉用户。`,
      },
    };
  };
}
