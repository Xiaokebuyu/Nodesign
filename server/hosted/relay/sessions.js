/**
 * server/hosted/relay/sessions.js —— relay 的会话登记：sid → { userId, deviceId, appModel, mode }
 *
 * ## 为什么要登记，而不是每发按 body.model 查
 *
 * SDK 发出来的 body.model 是 **spoof 别名**，不是用户选的那一行（model-table 的 SHARED_SDK_ALIAS：
 * 多行共用同一个别名，全表反查分不出它们）；而 helper 请求（标题、摘要）用的是 SDK 自己
 * config 里的默认 Claude 名，根本不在表里。站内的入口靠 session-loop 在起 query 之前
 * registerIngressSession(sid, appModel) 才认得出这些请求。relay 上没有 session-loop，
 * 客户端得自己来登记一次：POST /sessions { sid, appModel }。
 *
 * 登记的东西也是**判决的依据**：走哪条腿（订阅 / API）看的是登记的 appModel，不看每发
 * body.model —— body.model 由客户端随便填，它只能在登记那一行和那一行的 fast 行之间选
 * （session-routes.resolveSessionWire 的撞名雷防线），选不到就改道 fast，永远跨不到别的行。
 *
 * ## 谁能用这个 sid
 *
 * sid 绑定登记它的用户。别人的 sid 拿来用 → 403。sid 由客户端生成（SDK 会话 id，uuid），
 * 撞上的概率可以忽略；万一撞了（同一个 sid 两个用户登记），后来者 409。
 *
 * ## 寿命
 *
 * 客户端 finally 里 DELETE 注销；客户端崩了没注销的，空闲超过 IDLE_TTL 由清扫器收掉
 * （连带 unregisterIngressSession，那张表没有自己的 TTL）。
 */

import { resolveModelRoute } from '../../engine/agent/model-context.js';
import { registerIngressSession, unregisterIngressSession } from '../../lib/ingress/session-routes.js';

const IDLE_TTL_MS = 2 * 60 * 60 * 1000;   // 两小时没动静就当客户端死了
const SWEEP_EVERY_MS = 10 * 60 * 1000;
const MAX_PER_USER = 64;                   // 一个人同时开这么多会话不合理，超了先收最老的

const sessions = new Map();   // sid → { sid, userId, deviceId, appModel, mode, openedAt, lastSeen }

const VALID_SID = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * @returns {{ ok: true, session: object } | { ok: false, status: number, code: string, message: string }}
 */
export function openRelaySession({ sid, appModel, userId, deviceId = null }) {
  if (!VALID_SID.test(String(sid || ''))) return { ok: false, status: 400, code: 'BAD_SID', message: 'sid 要是 8-128 位的 [A-Za-z0-9_-]' };
  if (typeof appModel !== 'string' || !appModel) return { ok: false, status: 400, code: 'BAD_MODEL', message: 'appModel 必填' };
  const existing = sessions.get(sid);
  if (existing && existing.userId !== userId) return { ok: false, status: 409, code: 'SID_TAKEN', message: '这个 sid 已被别的账号登记' };

  const route = resolveModelRoute(appModel);
  const session = { sid, userId, deviceId, appModel, mode: route.mode, openedAt: Date.now(), lastSeen: Date.now() };
  // 同一用户重复登记同一个 sid（客户端重试）= 幂等更新
  if (existing) unregisterIngressSession(sid);
  sessions.set(sid, session);
  if (route.mode === 'api') registerIngressSession(sid, appModel);

  // 每人上限：超了收最老的（按 lastSeen）
  const mine = [...sessions.values()].filter((s) => s.userId === userId);
  if (mine.length > MAX_PER_USER) {
    mine.sort((a, b) => a.lastSeen - b.lastSeen);
    for (const s of mine.slice(0, mine.length - MAX_PER_USER)) closeRelaySession(s.sid, userId);
  }
  return { ok: true, session };
}

/** 注销。只有登记者本人能注销；不存在或不是本人 → false（幂等，不报错） */
export function closeRelaySession(sid, userId) {
  const s = sessions.get(sid);
  if (!s || s.userId !== userId) return false;
  sessions.delete(sid);
  unregisterIngressSession(sid);
  return true;
}

/**
 * 请求进来时查 sid。查到且属于这个用户 → 顺手续命；不属于 → null（调用方回 403，
 * 跟"没登记"区分开，方便客户端排错）。
 */
export function lookupRelaySession(sid, userId) {
  const s = sessions.get(sid);
  if (!s) return { session: null, reason: 'unknown' };
  if (s.userId !== userId) return { session: null, reason: 'foreign' };
  s.lastSeen = Date.now();
  return { session: s, reason: 'ok' };
}

export function sweepRelaySessions(now = Date.now()) {
  let n = 0;
  for (const s of sessions.values()) {
    if (now - s.lastSeen > IDLE_TTL_MS) { closeRelaySession(s.sid, s.userId); n++; }
  }
  return n;
}

let sweeper = null;
export function startRelaySessionSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const n = sweepRelaySessions();
    if (n) console.log(`[relay] 清掉 ${n} 个空闲会话登记`);
  }, SWEEP_EVERY_MS);
  sweeper.unref();
}

/** 测试用 */
export function _resetRelaySessions() {
  for (const sid of [...sessions.keys()]) unregisterIngressSession(sid);
  sessions.clear();
}
export function _relaySessionCount() { return sessions.size; }
