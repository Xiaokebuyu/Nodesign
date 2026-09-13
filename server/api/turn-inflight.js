/**
 * server/api/turn-inflight.js — POST /turn 的 requestId 去重（2026-08-20 从 turn.js 拆出，
 * 行数棘轮；逻辑原样）。
 */

/**
 * Phase A.6（2026-05-07）：requestId LRU dedup —— 弱网下用户重发 / fetch retry
 * 同 requestId 直接返已存在的 { runId, sessionId }，不重复 createRun / startNewRunSession。
 *
 * 数据：Map<requestId, { pid, runId, sessionId, ts }>，简单 5 分钟 TTL + 1024 容量上限
 * （超过先驱逐最旧）。同进程内存，重启清空（此时活 run 也都死了，一致）。
 *
 * race 修复（2026-05-08）：原版 lruGet → createRun → lruPut 之间无并发保护。两个
 * 并发 POST 同 requestId 都通过 lruGet 返 null → 各自 createRun → 双 run 同 sid
 * 推进同 inputQueue → agent 收两条同 chat 处理两轮（双倍 token / canvas 双写）。
 *
 * 加 inflightTurns Map<requestId, Promise<result>>：第一 POST 进来注册 in-flight
 * Promise；第二 POST 看到 in-flight 就 await 拿第一个的 result 返 deduped。
 * 第一个 POST 拿到 res 写完 lruPut + resolveInflight，5s 后 delete in-flight（让
 * LRU 接管后续幂等查询）。
 */
const REQUEST_LRU_TTL_MS = 5 * 60 * 1000;
const REQUEST_LRU_MAX = 1024;
const requestLru = new Map();
export const inflightTurns = new Map();  // requestId → Promise<{ pid, runId, sessionId }>
export const INFLIGHT_RETENTION_MS = 5_000;
export function lruGet(requestId) {
  const rec = requestLru.get(requestId);
  if (!rec) return null;
  if (Date.now() - rec.ts > REQUEST_LRU_TTL_MS) {
    requestLru.delete(requestId);
    return null;
  }
  return rec;
}
export function lruPut(requestId, rec) {
  if (requestLru.size >= REQUEST_LRU_MAX) {
    // 驱逐最早（Map 保留插入顺序）
    const firstKey = requestLru.keys().next().value;
    if (firstKey) requestLru.delete(firstKey);
  }
  requestLru.set(requestId, { ...rec, ts: Date.now() });
}

/**
 * 登记 in-flight 并兜住所有早退（09-13 fable 审查第三轮 P1-1）。
 * 登记之后 turn.js 还有一串早退（跨租户 404、回退中 409、模型锁 403、额度 429…），以前只有外审 451 和 catch
 * 两处记得 reject + 清条目；其余早退后，同 requestId 的重发会一直 await 一个永远不 settle 的承诺（前端 jsonRequest 无超时），
 * 条目也泄漏。这里在**服务端结束响应**的那一刻兜底：还没 resolve 就 reject 并清条目，重发 fallthrough 自己重跑。
 * ⚠️ 挂 res.end 而不是 'close'：客户端弱网先断开第一发时 'close' 会提前触发，重发就绕过去重多跑一轮。
 * @param {string} requestId
 * @param {{ end: Function }} res
 * @returns {{ resolve: (v: object) => void, reject: (err: Error) => void }}
 */
export function registerInflight(requestId, res) {
  let settled = false; let rs; let rj;
  const p = new Promise((a, b) => { rs = a; rj = b; });
  p.catch(() => {});   // 防 unhandled rejection
  inflightTurns.set(requestId, p);
  const drop = () => { if (inflightTurns.get(requestId) === p) inflightTurns.delete(requestId); };
  const end = res.end;
  res.end = function patchedEnd(...args) {
    if (!settled) { settled = true; rj(new Error('turn ended without a run')); drop(); }
    return end.apply(this, args);
  };
  return {
    resolve: (v) => { if (settled) return; settled = true; rs(v); setTimeout(drop, INFLIGHT_RETENTION_MS); },
    reject: (err) => { if (settled) return; settled = true; rj(err); drop(); },
  };
}

