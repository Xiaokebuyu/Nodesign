#!/usr/bin/env node
/**
 * Turnstile 测量期报表（hosted/auth/turnstile-probe.js 记的数）。只读打开库。
 *
 *   node server/scripts/turnstile-report.mjs            # 全部
 *   node server/scripts/turnstile-report.mjs --days 7   # 最近 7 天
 *
 * 通过 = 浏览器拿到令牌且服务端核验成功（verify_ok=1）。判定口径：大陆（CN）通过率 ≥ 98% 且样本 ≥ 200 才考虑开强制。
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(root, 'server/db/nodesign.db');
const i = process.argv.indexOf('--days');
const since = i > 0 ? Date.now() - Number(process.argv[i + 1]) * 86400_000 : 0;

const db = new DatabaseSync(dbPath, { readOnly: true });
let rows;
try {
  rows = db.prepare(`SELECT COALESCE(country, '??') AS country, COUNT(*) AS n,
      SUM(outcome = 'passed' AND verify_ok = 1) AS passed,
      SUM(outcome = 'passed' AND verify_ok IS NOT 1) AS passed_unverified,
      SUM(outcome IN ('script_error', 'script_timeout')) AS script_fail,
      SUM(outcome = 'error') AS widget_error,
      SUM(outcome = 'challenge_timeout') AS challenge_timeout,
      SUM(outcome = 'interaction_required') AS interaction,
      CAST(AVG(CASE WHEN outcome = 'passed' THEN total_ms END) AS INTEGER) AS avg_ms
    FROM turnstile_probes WHERE created_at > ? GROUP BY country ORDER BY n DESC`).all(since);
} catch (err) {
  console.error(`读不到 turnstile_probes（还没开测量？）：${err.message}`);
  process.exit(1);
}
const pct = (a, n) => (n ? `${((100 * a) / n).toFixed(1)}%` : '-');
console.log('国家\t样本\t通过\t脚本加载失败\t组件报错\t挑战超时\t需手动点击\t核验未过\t通过平均耗时');
for (const r of rows) {
  console.log([r.country, r.n, pct(r.passed, r.n), pct(r.script_fail, r.n), pct(r.widget_error, r.n), pct(r.challenge_timeout, r.n), pct(r.interaction, r.n),
    pct(r.passed_unverified, r.n), r.avg_ms == null ? '-' : `${r.avg_ms}ms`].join('\t'));
}
