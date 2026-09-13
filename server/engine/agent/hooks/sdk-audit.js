/**
 * 审计型钩子（2026-09-13）：StopFailure / Notification / PreModelSwitch / PostModelSwitch。
 *
 * 只留痕，不改行为，一律返回 {}。字段口径以 sdk.d.ts 为准（SDK 0.3.269）。
 *   - SessionEnd 没挂：09-13 真跑探针（SDK 0.3.269），query.close() 与输入流正常结束都不触发回调型钩子。
 *   - StopFailure：整轮异常终止（上游 API 错误、压缩后仍超长等）。前端已经由 result 分支报失败，
 *     这里只进问题库，按错误类型聚合。
 *   - Notification：CLI 送出通知前（带 notification_type）。只记日志，toast 仍走 system notification 消息。
 *   - Pre/PostModelSwitch：我们自己切模型走 setModel（source=sdk）；source=auto 是 CLI 自动换的，
 *     跟「不自动换线」的定案冲突，进问题库。to_model 是 CLI 看到的名字（可能是 spoof 别名），不直接拿去记账。
 */
import { recordIssue } from '../../../lib/issues-store.js';

const sid8 = (s) => String(s || '').slice(0, 8);

export function makeStopFailureAudit({ projectId, sessionId, record = recordIssue } = {}) {
  return async (input) => {
    try {
      const err = input?.error || 'unknown';
      console.warn(`[hook StopFailure] sid=${sid8(input?.session_id || sessionId)} error=${err} ${String(input?.error_details || '').slice(0, 200)}`);
      record({
        source: 'auto', kind: 'bug', toolName: 'sdk:stop_failure',
        summary: `回合异常终止：${err}`,
        detail: [input?.error_details, input?.last_assistant_message && `最后一条回复：${String(input.last_assistant_message).slice(0, 500)}`]
          .filter(Boolean).join('\n') || null,
        signature: `stop-failure:${err}`, projectId: projectId || null, sessionId: input?.session_id || sessionId || null,
      });
    } catch { /* */ }
    return {};
  };
}

export function makeNotificationAudit({ sessionId } = {}) {
  return async (input) => {
    try {
      console.log(`[hook Notification] sid=${sid8(input?.session_id || sessionId)} type=${input?.notification_type} ${String(input?.message || '').slice(0, 160)}`);
    } catch { /* */ }
    return {};
  };
}

export function makeModelSwitchAudit({ projectId, sessionId, record = recordIssue } = {}) {
  return async (input) => {
    try {
      const phase = input?.hook_event_name === 'PreModelSwitch' ? 'Pre' : 'Post';
      const line = `${input?.from_model} → ${input?.to_model} source=${input?.source} ctx=${input?.context_tokens} cacheWarm=${input?.prompt_cache_warm} estCacheWrite=$${input?.estimated_cache_write_usd}`;
      console.log(`[hook ${phase}ModelSwitch] sid=${sid8(input?.session_id || sessionId)} ${line}`);
      if (phase === 'Post' && input?.source === 'auto') {
        record({
          source: 'auto', kind: 'bug', toolName: 'sdk:model_switch_auto',
          summary: `CLI 自动切换了会话模型：${input.from_model} → ${input.to_model}`,
          detail: `${line}。我们的定案是不自动换线，需要查是哪条机制触发的。`,
          signature: 'model-switch-auto', projectId: projectId || null, sessionId: input?.session_id || sessionId || null,
        });
      }
    } catch { /* */ }
    return {};
  };
}
