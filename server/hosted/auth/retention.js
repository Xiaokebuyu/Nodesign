/**
 * server/hosted/auth/retention.js — 登录与安全记录的保存期限（隐私政策 §8 的承诺由这里兑现）
 *
 *   网页登录会话：失效（到期或吊销）满 180 天删除
 *   账号安全事件（auth_events）：满 180 天删除
 *   验证码记录与验证码错误计数：满 30 天删除（限频只看 24 小时，留 30 天够排查）
 *
 * 起动时跑一次，之后每天一次。改期限要同时改 web/public/welcome/privacy.html 第 8 节。
 */

import db from '../../engine/runs/store.js';

export const RETENTION = {
  sessionsMs: 180 * 24 * 3600 * 1000,
  eventsMs: 180 * 24 * 3600 * 1000,
  codesMs: 30 * 24 * 3600 * 1000,
};

/** @returns {{ sessions: number, events: number, codes: number, failures: number }} */
export function pruneAuthRecords(now = Date.now()) {
  const sessions = db.prepare(`DELETE FROM auth_sessions WHERE COALESCE(revoked_at, expires_at) < ? AND (revoked_at IS NOT NULL OR expires_at < ?)`)
    .run(now - RETENTION.sessionsMs, now).changes;
  const events = db.prepare('DELETE FROM auth_events WHERE created_at < ?').run(now - RETENTION.eventsMs).changes;
  const codes = db.prepare('DELETE FROM email_codes WHERE created_at < ?').run(now - RETENTION.codesMs).changes;
  const failures = db.prepare('DELETE FROM email_code_failures WHERE at < ?').run(now - RETENTION.codesMs).changes;
  return { sessions, events, codes, failures };
}

let timer = null;
export function startAuthRetention() {
  if (timer) return;
  const run = () => {
    try {
      const r = pruneAuthRecords();
      if (r.sessions || r.events || r.codes || r.failures) console.log(`[auth-retention] 已删除过期记录 ${JSON.stringify(r)}`);
    } catch (err) {
      console.warn(`[auth-retention] 清理失败：${err.message}`);
    }
  };
  run();
  timer = setInterval(run, 24 * 3600 * 1000);
  timer.unref?.();
}
