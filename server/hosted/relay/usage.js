/**
 * server/hosted/relay/usage.js — relay 的服务端账本
 *
 * ## 为什么必须另起一本
 *
 * quota.js 的口径是「服务器上这个用户的 runs」（run_model_usage JOIN runs）。
 * 网页端成立，因为 agent 循环跑在服务器上，每一轮都落一条 run。桌面版把循环搬到了
 * 用户自己机器上，run 落在他自己的库里，服务器一条也看不到 —— usedCostToday 恒为 0，
 * 额度闸永远不触发。
 *
 * 而且客户端报的数一个字都不能信：它在用户手里，代码能改。所以这本账只记
 * **relay 自己看见的东西**：请求经过我们、响应从我们这儿流回去，费用从上游的响应里读。
 *
 * ## 跟网页端那本账的关系
 *
 * 相加，不是各算各的。同一个人网页端和桌面版花的是同一份预算，分成两个额度
 * 等于给每个人悄悄翻倍。合并的方式是往 quota.js 注册一个来源（内核不 import
 * hosted，只能反向注入，见 server/scripts/check-client-boundary.mjs）。
 *
 * ## 费用从哪来
 *
 * 上游自报（lib/ingress/upstream-billing.js 的 upstreamCostOf，Zen 放顶层 cost、
 * Merge 网关放 usage.cost）。上游没报就是 null —— 那种情况下这一发记 0 而不是估一个数，
 * 理由同那个文件：假数据比没有更坏。记 0 的代价是额度偏松，会在日志里吵一声。
 */

import db from '../../engine/runs/store.js';
import { dayStartUtcSql, registerUsageSource } from '../../lib/quota.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS relay_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    device_id TEXT,
    model TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read INTEGER,
    cache_create INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_relay_usage_user_time ON relay_usage(user_id, created_at);
`);

/**
 * 记一发。costUsd 拿不到就传 null —— 会记 0 并吵一声，不要在这里估。
 * @returns {number} 这条记进去的金额
 */
export function recordRelayUsage({
  userId, deviceId = null, model = null, costUsd = null,
  inputTokens = null, outputTokens = null, cacheRead = null, cacheCreate = null,
}) {
  if (!userId) throw new Error('recordRelayUsage: userId 必填');
  const cost = Number.isFinite(costUsd) ? costUsd : 0;
  if (!Number.isFinite(costUsd)) {
    console.warn(`[relay-usage] 上游没报费用（model=${model}），这一发记 0，额度会偏松`);
  }
  db.prepare(`INSERT INTO relay_usage
      (user_id, device_id, model, cost_usd, input_tokens, output_tokens, cache_read, cache_create)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, deviceId, model, cost, inputTokens, outputTokens, cacheRead, cacheCreate);
  return cost;
}

/** 当天（跟 quota.js 同一个 +08:00 日界）走 relay 花掉的美元 */
export function relayCostToday(userId, now = Date.now()) {
  return db.prepare(
    'SELECT COALESCE(SUM(cost_usd), 0) AS used FROM relay_usage WHERE user_id = ? AND created_at >= ?',
  ).get(userId, dayStartUtcSql(now)).used;
}

/** 全史（终身额度口径） */
export function relayCostTotal(userId) {
  return db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS used FROM relay_usage WHERE user_id = ?')
    .get(userId).used;
}

/** 近 N 天每日每模型（口径同 quota.dailyCostSeries；+08:00 日界） */
export function relayDailySeries(userId, days = 30, now = Date.now()) {
  const n = Math.max(1, Math.min(366, Math.floor(days) || 30));
  const since = dayStartUtcSql(now - (n - 1) * 24 * 60 * 60 * 1000);
  return db.prepare(
    `SELECT substr(datetime(created_at, '+8 hours'), 1, 10) AS day, model, COALESCE(SUM(cost_usd), 0) AS cost
       FROM relay_usage WHERE user_id = ? AND created_at >= ? GROUP BY day, model`,
  ).all(userId, since).map((r) => ({ day: r.day, model: r.model, costUsd: r.cost }));
}

let installed = false;

/**
 * 把这本账并进 quota.js。**幂等** —— 注册两次等于每一笔都算两遍，
 * 那种错在账面上看起来只是"用户花得比预期多"，很难往回查到是注册重复。
 */
export function installRelayUsageSource() {
  if (installed) return false;
  registerUsageSource({ today: relayCostToday, total: relayCostTotal, daily: relayDailySeries });
  installed = true;
  return true;
}

/** 测试用 */
export function _resetInstalled() { installed = false; }
