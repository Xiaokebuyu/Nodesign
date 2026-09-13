/**
 * 上游回头续写已闭合的 tool_call → 问题库（2026-09-13，只计数不改逻辑）。
 *
 * 转换层（openai-chat.js）只能把这种增量并进已经发过 content_block_stop 的块；CLI 的 StreamingToolExecutor
 * 在块闭合那一刻就按当时的参数派发执行，之后续上的参数进不去 —— 那一步按半截参数运行了。
 * 先量有没有真发生过、发生在哪条上游，再决定要不要在转换层缓冲。
 */
import { recordIssue } from '../issues-store.js';

export function noteToolCallReopened({ wire, sidShort, sessionTag, n, record = recordIssue }) {
  return record({
    source: 'auto', kind: 'bug', toolName: `upstream:${wire?.upstreamId}`,
    summary: `上游 ${wire?.upstreamId} 回头续写已闭合的工具调用`,
    detail: `会话 ${sidShort} 模型 ${wire?.appModel || wire?.wireModel}：一次响应里 ${n} 次回到已闭合的 tool_call 续参数。`
      + 'CLI 在块闭合时已按当时参数执行，续上的参数被丢弃。',
    signature: 'tool-call-reopened', sessionId: sessionTag,
  });
}
