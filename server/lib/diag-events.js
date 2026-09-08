/**
 * lib/diag-events.js —— 诊断分接头（2026-09-08 站主定「多埋几个点」）：挂在每个项目的 EventBus 上，
 * 把跟「模型这一发怎么样」和「工具这一下怎么样」有关的事件收进两本进程内的环形账，给诊断端点读：
 *   api_events ：run.api_retry / run.round.end（每轮用量与停止原因）/ run.context_usage / run.error / run.query.*
 *   tool_calls ：run.tool_use.started 配 run.delta.tool_result（同 blockId 算耗时）+ run.tool_failure
 * 另留每会话最近一次 context_usage 与压缩次数，给 session_status 用。
 * 09-08 那次要是有这本账，不用翻会话 jsonl 就能看见「七次 ToolSearch 各 20 个 token、缓存 0」。
 * 内存有界：两本各 500 条；只记摘要，不记正文（tool_result 的 output 不进来）。
 */

const CAP = 500;
const apiEvents = [];
const toolCalls = [];
const openTools = new Map();          // blockId → { startedAt, name, sessionId, runId, round }
const sessionStats = new Map();       // sessionId → { contextUsage, compactions, lastEventAt, rounds }

function push(buf, item) { buf.push(item); if (buf.length > CAP) buf.shift(); }
const brief = (v, n = 160) => { const s = typeof v === 'string' ? v : JSON.stringify(v ?? null); return s && s.length > n ? `${s.slice(0, n)}…` : s; };

function statsOf(sid) {
  let s = sessionStats.get(sid);
  if (!s) { s = { contextUsage: null, compactions: 0, lastEventAt: null, rounds: 0 }; sessionStats.set(sid, s); }
  return s;
}

/** 给 EventBus.subscribe('*') 的处理器；导出是为了单测直接喂事件 */
export function onDiagEvent(ev, projectId = null) {
  if (!ev || !ev.type) return;
  const base = { ts: ev.ts || new Date().toISOString(), projectId, sessionId: ev.sessionId || null, runId: ev.runId || null };
  const s = ev.sessionId ? statsOf(ev.sessionId) : null;
  if (s) s.lastEventAt = base.ts;
  switch (ev.type) {
    case 'run.api_retry':
      push(apiEvents, { ...base, kind: 'retry', attempt: ev.attempt, maxRetries: ev.maxRetries, retryDelayMs: ev.retryDelayMs, status: ev.errorStatus ?? null, error: ev.errorKind ?? null });
      break;
    case 'run.round.end':
      if (s) s.rounds += 1;
      push(apiEvents, { ...base, kind: 'round', round: ev.round, stopReason: ev.stopReason ?? null, usage: ev.usage ? { in: ev.usage.input_tokens ?? ev.usage.inputTokens ?? null, out: ev.usage.output_tokens ?? ev.usage.outputTokens ?? null, cacheRead: ev.usage.cache_read_input_tokens ?? ev.usage.cacheReadTokens ?? null } : null });
      break;
    case 'run.context_usage':
      if (s) s.contextUsage = { totalTokens: ev.totalTokens ?? null, maxTokens: ev.maxTokens ?? null, percentage: ev.percentage ?? null, at: base.ts };
      break;
    case 'run.compact_boundary':
      if (s) s.compactions += 1;
      push(apiEvents, { ...base, kind: 'compact', meta: brief(ev.compactMetadata, 200) });
      break;
    case 'run.error':
      push(apiEvents, { ...base, kind: 'error', code: ev.code ?? null, message: brief(ev.message) });
      break;
    case 'run.query.start':
    case 'run.query.end':
      push(apiEvents, { ...base, kind: ev.type === 'run.query.start' ? 'query_start' : 'query_end' });
      break;
    case 'run.tool_use.started':
      openTools.set(ev.blockId, { startedAt: Date.now(), name: ev.name, ...base, round: ev.round });
      if (openTools.size > CAP) openTools.delete(openTools.keys().next().value);
      break;
    case 'run.delta.tool_result': {
      const o = openTools.get(ev.blockId);
      openTools.delete(ev.blockId);
      push(toolCalls, { ts: base.ts, projectId, sessionId: base.sessionId, runId: base.runId, round: ev.round, name: ev.name || o?.name || null, ok: ev.ok !== false, ms: o ? Date.now() - o.startedAt : null, error: ev.error ? brief(ev.error) : null });
      break;
    }
    case 'run.tool_failure':
      push(toolCalls, { ts: base.ts, projectId, sessionId: base.sessionId, runId: base.runId, name: ev.toolName || null, ok: false, ms: null, error: brief(ev.error) });
      break;
    default:
  }
}

/** 挂到一个项目的 bus 上（broker 建 bus 时调一次） */
export function attachDiagnosticsTap(bus, projectId) {
  return bus.subscribe('*', (ev) => onDiagEvent(ev, projectId));
}

const filt = (buf, { sessionId, limit }) => {
  const rows = sessionId ? buf.filter((r) => r.sessionId === sessionId) : buf;
  return rows.slice(-(limit || 100));
};
export function listApiEvents(opts = {}) { return filt(apiEvents, opts); }
export function listToolCalls(opts = {}) { return filt(toolCalls, opts); }
export function sessionDiagStats(sessionId) { return sessionStats.get(sessionId) || null; }
export function _resetDiagEvents() { apiEvents.length = 0; toolCalls.length = 0; openTools.clear(); sessionStats.clear(); }
