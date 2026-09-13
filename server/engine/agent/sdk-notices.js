/**
 * server/engine/agent/sdk-notices.js —— 之前落进 default warn 的 SDK 消息（2026-09-13 接上）
 *
 * agent-shared.js 的两个 switch（外层 msg.type、system 的 subtype）在 default 之前先问这里；
 * 返回 true = 认识并处理了。字段口径以 sdk.d.ts 为准（SDK 0.3.269）。
 *
 * 分三档：
 *   - 要让人知道的：informational（通用横幅）、拒答两条（进问题库 + toast）
 *   - 要留痕的：permission_denied（自动拒绝，auto 分类器 / deny 规则；PreToolUse 钩子的拒绝不在其内）、
 *     worker_shutting_down（CLI 自报要退，区分「我们关的」和「它自己要关」）、conversation_reset
 *   - 先看内容再定用途的：active_goal / post_turn_summary / task_summary / autocompact_state /
 *     commands_changed / background_tasks_changed —— 类型联合里不全有，但 sdk.mjs 运行时确实会流出。
 *     每个会话每种只打一条样本日志，不刷屏。commands_changed 的清单顺手存到 ctx，给以后的斜杠命令入口。
 */
import { Events } from './events.js';
import { recordIssue } from '../../lib/issues-store.js';

const SAMPLE_ONCE = new Set([
  'active_goal', 'post_turn_summary', 'task_summary', 'autocompact_state',
  'commands_changed', 'background_tasks_changed',
]);

const INFO_PRIORITY = { warning: 'warn', notice: 'medium', suggestion: 'low', info: 'low' };

function sampleOnce(ctx, key, msg) {
  if (!ctx._sdkSampled) ctx._sdkSampled = new Set();
  if (ctx._sdkSampled.has(key)) return;
  ctx._sdkSampled.add(key);
  let body = '';
  try { body = JSON.stringify(msg).slice(0, 600); } catch { body = '(unserializable)'; }
  console.log(`[run ${ctx.runId}] SDK ${key}（本会话首条样本）: ${body}`);
}

/**
 * @param {import('./context.js').AgentContext} ctx
 * @param {object} msg  SDK 消息
 * @param {{ record?: typeof recordIssue }} [deps]  测试注入
 * @returns {boolean}
 */
export function handleSdkNotice(ctx, msg, { record = recordIssue } = {}) {
  const key = msg?.type === 'system' ? msg.subtype : msg?.type;
  switch (key) {
    case 'informational':
      if (msg.content) ctx.emit(Events.notification('sdk_informational', msg.content, INFO_PRIORITY[msg.level] || 'low'));
      if (msg.prevent_continuation) console.warn(`[run ${ctx.runId}] SDK informational 且阻止继续: ${String(msg.content).slice(0, 200)}`);
      return true;

    case 'model_refusal_fallback':
    case 'model_refusal_no_fallback': {
      const fell = key === 'model_refusal_fallback';
      const detail = fell
        ? `${msg.original_model} 拒答，CLI 已改用 ${msg.fallback_model} 重试（direction=${msg.direction}，scope=${msg.scope || 'session'}）。`
        : `${msg.original_model} 拒答，未重试。`;
      console.warn(`[run ${ctx.runId}] ${detail} category=${msg.api_refusal_category || '-'} request=${msg.request_id || '-'}`);
      record({
        source: 'auto', kind: 'bug', toolName: 'sdk:model_refusal',
        summary: fell ? `模型拒答后被自动换到 ${msg.fallback_model}` : `模型拒答（${msg.original_model}）`,
        detail: `${detail}${msg.api_refusal_category ? ` 类别 ${msg.api_refusal_category}。` : ''}${msg.api_refusal_explanation ? ` 说明：${msg.api_refusal_explanation}` : ''}`,
        signature: fell ? 'model-refusal-fallback' : 'model-refusal', sessionId: ctx.sessionId || null,
      });
      ctx.emit(Events.notification('model_refusal', fell
        ? `模型拒绝回答这一轮，已改用 ${msg.fallback_model} 重试`
        : '模型拒绝回答这一轮', 'warn'));
      return true;
    }

    case 'permission_denied':
      console.warn(`[run ${ctx.runId}] 工具调用被自动拒绝: ${msg.tool_name} (${msg.decision_reason_type || '-'}) ${String(msg.decision_reason || msg.message || '').slice(0, 200)}`);
      ctx.emit(Events.permissionDenied({
        toolName: msg.tool_name, toolUseId: msg.tool_use_id, agentId: msg.agent_id || null,
        reasonType: msg.decision_reason_type || null, reason: msg.decision_reason || null, message: msg.message || '',
      }));
      return true;

    case 'worker_shutting_down':
      console.log(`[run ${ctx.runId}] CLI 自报即将退出: ${msg.reason}`);
      return true;

    case 'conversation_reset':
      console.log(`[run ${ctx.runId}] SDK conversation_reset → ${msg.new_conversation_id}`);
      ctx.emit(Events.conversationReset(msg.new_conversation_id));
      return true;

    default:
      if (!SAMPLE_ONCE.has(key)) return false;
      if (key === 'commands_changed' && Array.isArray(msg.commands)) ctx.sdkCommands = msg.commands;
      sampleOnce(ctx, key, msg);
      return true;
  }
}
