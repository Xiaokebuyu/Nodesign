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
const relayCalls = [];                // 桌面 relay-client 每一发：发出 / 响应头 / 收完 三个时刻
const stderrTail = new Map();         // sessionId → 最近 20 行 CLI stderr（进程退出时随 query_end 一起记）
const balances = new Map();           // upstreamId → { usd, at }（网关余额只在响应头上，没人存）
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
      push(apiEvents, { ...base, kind: 'query_start' });
      break;
    case 'run.query.end':
      push(apiEvents, { ...base, kind: 'query_end', reason: ev.reason ?? null, lastStderr: stderrTail.get(ev.sessionId) || [] });
      break;
    case 'run.tool_use.started':
      openTools.set(ev.blockId, { startedAt: Date.now(), name: ev.name, ...base, round: ev.round });
      if (openTools.size > CAP) openTools.delete(openTools.keys().next().value);
      break;
    case 'run.delta.tool_use': {   // 完整 tool_use 块（非流式路径只有这条带名字）：补名字，没起过就当此刻起
      const o = openTools.get(ev.blockId);
      if (o) { if (!o.name || o.name === '<sdk-tool>') o.name = ev.name; }
      else { openTools.set(ev.blockId, { startedAt: Date.now(), name: ev.name, ...base, round: ev.round }); }
      break;
    }
    case 'run.delta.tool_result': {
      const o = openTools.get(ev.blockId);
      openTools.delete(ev.blockId);
      // tool_result 事件里的 name 是占位符 '<sdk-tool>'（SDK 不带名），真名从 tool_use 配对
      const name = (o?.name && o.name !== '<sdk-tool>') ? o.name : ((ev.name && ev.name !== '<sdk-tool>') ? ev.name : null);
      push(toolCalls, { ts: base.ts, projectId, sessionId: base.sessionId, runId: base.runId, round: ev.round, name, ok: ev.ok !== false, ms: o ? Date.now() - o.startedAt : null, error: ev.error ? brief(ev.error) : null });
      break;
    }
    case 'run.tool_failure':
      push(toolCalls, { ts: base.ts, projectId, sessionId: base.sessionId, runId: base.runId, name: ev.toolName || null, ok: false, ms: null, error: brief(ev.error) });
      break;
    default:
  }
}

/** CLI 子进程的 stderr：每会话留最近 20 行（session-loop 的 stderr 回调喂） */
export function noteStderr(sessionId, line) {
  if (!sessionId || !line) return;
  let ring = stderrTail.get(sessionId);
  if (!ring) { ring = []; stderrTail.set(sessionId, ring); if (stderrTail.size > 200) stderrTail.delete(stderrTail.keys().next().value); }
  ring.push(`${new Date().toISOString().slice(11, 19)} ${brief(line, 300)}`);
  if (ring.length > 20) ring.shift();
}

/** 首发请求的组成（model-ingress 在每会话第一发时喂）：系统提示字数 / reminder 段数 / 工具数 / 消息数 */
export function noteFirstRequest(sessionId, shape) {
  if (!sessionId || !shape) return;
  const st = statsOf(sessionId);
  if (st.firstRequest) return;
  st.firstRequest = { at: new Date().toISOString(), ...shape };
  push(apiEvents, { ts: st.firstRequest.at, projectId: null, sessionId, runId: null, kind: 'first_request', ...shape });
}

/** relay-client 每一发（桌面）：跟站点 relay_usage 对账用 */
export function noteRelayCall(entry) { push(relayCalls, { ts: new Date().toISOString(), ...entry }); }
export function listRelayCalls({ limit } = {}) { return relayCalls.slice(-(limit || 100)); }

/** 上游余额头（merge 的 x-credit-balance-usd）：变了才记一条；掉得快就 warn */
export function noteBalance(upstreamId, usd) {
  const v = Number(usd);
  if (!upstreamId || !Number.isFinite(v)) return;
  const prev = balances.get(upstreamId);
  balances.set(upstreamId, { usd: v, at: new Date().toISOString() });
  if (prev && Math.abs(prev.usd - v) < 0.005) return;
  push(apiEvents, { ts: new Date().toISOString(), projectId: null, sessionId: null, runId: null, kind: 'balance', upstreamId, usd: v, prevUsd: prev?.usd ?? null });
  if (prev && prev.usd - v >= 0.5) console.warn(`[diag] upstream=${upstreamId} 余额 ${prev.usd.toFixed(2)} → ${v.toFixed(2)} USD（一发之间掉了 ${(prev.usd - v).toFixed(2)}）`);
}
export function upstreamBalances() { return Object.fromEntries(balances); }

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
export function _resetDiagEvents() { apiEvents.length = 0; toolCalls.length = 0; relayCalls.length = 0; openTools.clear(); sessionStats.clear(); stderrTail.clear(); balances.clear(); }
