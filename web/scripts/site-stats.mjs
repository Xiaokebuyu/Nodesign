#!/usr/bin/env node
/**
 * 官网「产品现状」等数字自动刷新（2026-09-11）。
 *
 * 页面里要自动更新的数字都包在 `data-stat="<键>"` 的元素里（<b>/<span>），本脚本算出每个键的值，
 * 只替换元素内的文字。部署时跑一次（deploy.sh 末尾），每天北京时间凌晨再跑一次（crontab）。
 *
 * 口径（09-11 定，页面上也写明了）：
 *   - 用户 / 会话一律排除内部账号：role=admin 与 测试01 / test123 / zhuceshishi（同 0911 使用数据报告）
 *   - 会话 = 近 30 天 runs 里按 session_id 去重；token = 输入 + 输出（不含缓存读写）；费用含免费模型
 *   - 测试用例 = 测试文件里 it()/test() 的静态计数，向下取整到百位写「余」（静态计数比实跑少约 1%，不写精确值）
 *   - 工具 = 实例化 MCP 服务端数 toolNames（设计模式），子进程 + 临时目录，碰不到生产库
 *
 * 任何一项算失败就保留页面上的旧值（不清空、不写 NaN）。只改有变化的文件，先写临时文件再原子替换。
 *
 * 用法：node web/scripts/site-stats.mjs [--dir=web/dist/welcome] [--dry]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// SITE_STATS_ROOT：数据来源（.env / 库 / git / server 代码）指到别的检出，用于在 worktree 里先空跑
const ROOT = path.resolve(process.env.SITE_STATS_ROOT || path.resolve(HERE, '../..'));
const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const DIR = path.resolve(arg('dir', path.join(ROOT, 'web/dist/welcome')));
const DRY = process.argv.includes('--dry');

export const INTERNAL_USERNAMES = ['测试01', 'test123', 'zhuceshishi'];
/** 本脚本会算的全部键。页面上每个 data-stat 都必须在这里（site-stats.test.js 钉着），否则那个数永远不更新 */
export const KEYS = ['asOf', 'users', 'sessions30', 'medianTokens', 'medianCost', 'medianCostNum', 'p75Cost', 'commits', 'tests', 'tools', 'dailyQuota', 'quotaSessions'];

function dbPath() {
  try {
    const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = /^DB_PATH=(.+)$/m.exec(env);
    if (m) return path.resolve(ROOT, m[1].trim());
  } catch { /* 没 .env 用默认 */ }
  return path.join(ROOT, 'server/db/nodesign.db');
}

const fmtInt = (n) => n.toLocaleString('en-US');
export function bjDate(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${t.getUTCFullYear()} 年 ${t.getUTCMonth() + 1} 月 ${t.getUTCDate()} 日`;
}
export const fmtWan = (n) => (n >= 10000 ? `${(Math.round(n / 1000) / 10).toFixed(1)} 万` : fmtInt(Math.round(n)));
export const floorHundredYu = (n) => `${fmtInt(Math.floor(n / 100) * 100)} 余`;
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

async function dbStats() {
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(dbPath(), { readOnly: true });
  const internal = new Set(d.prepare(`select id from users where role='admin' or username in (${INTERNAL_USERNAMES.map(() => '?').join(',')})`).all(...INTERNAL_USERNAMES).map((r) => r.id));
  const users = d.prepare('select id from users').all().filter((u) => !internal.has(u.id)).length;
  const rows = d.prepare(`select user_id, session_id, input_tokens i, output_tokens o, total_cost_usd c from runs
    where created_at > datetime('now', '-30 days') and session_id is not null`).all();
  const s = new Map();
  for (const r of rows) {
    if (!r.user_id || internal.has(r.user_id)) continue;
    const v = s.get(r.session_id) || { t: 0, c: 0 };
    v.t += (r.i || 0) + (r.o || 0); v.c += r.c || 0; s.set(r.session_id, v);
  }
  const t = [...s.values()].map((x) => x.t), c = [...s.values()].map((x) => x.c);
  d.close();
  return { users, sessions30: s.size, medianTokens: median(t), medianCost: median(c), p75Cost: pct(c, 0.75) };
}

function gitStats() {
  const count = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim());
  const files = execFileSync('git', ['ls-files', '*.test.js', '*.test.jsx', '*.test.mjs'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const re = /(^|[^.\w])(it|test)(\.(each|skip|only|todo|concurrent)(\([^)]*\))?)?\s*\(\s*['"`]/g;
  let tests = 0;
  for (const f of files) { try { tests += (fs.readFileSync(path.join(ROOT, f), 'utf8').match(re) || []).length; } catch { /* 删了的文件 */ } }
  return { commits: count, tests };
}

function toolCount() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-sitestats-'));
  try {
    const code = `const m = await import(${JSON.stringify(path.join(ROOT, 'server/engine/mcp/index.js'))});
      const s = m.createNodesignMcpServer({ workspaceRoot: ${JSON.stringify(tmp)}, sharedRoot: ${JSON.stringify(tmp)}, projectId: 'p', sessionId: 's', ctx: {}, projectMode: 'design' });
      process.stdout.write('TOOLS=' + s.toolNames.length + '\\n'); process.exit(0);`;
    const env = { PATH: process.env.PATH, HOME: tmp, DB_PATH: path.join(tmp, 't.db'), PROJECTS_DATA_DIR: path.join(tmp, 'pd'), WORKSPACE_DIR: path.join(tmp, 'ws'), ARTIFACT_DIR: path.join(tmp, 'art') };
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: path.join(ROOT, 'server'), env, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /TOOLS=(\d+)/.exec(out);
    return m ? Number(m[1]) : null;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

async function dailyQuota() {
  const m = await import(path.join(ROOT, 'server/auth/tier.js'));
  return m.basicDefaultDailyUsd({});
}

/** 算全部键；单项失败记 null（后面保留旧值） */
export async function computeStats() {
  const out = { asOf: bjDate() };
  const tryIt = async (fn, keys) => { try { Object.assign(out, await fn()); } catch (e) { console.error(`[site-stats] ${keys} 失败：${e.message}`); } };
  await tryIt(async () => {
    const s = await dbStats();
    return { users: fmtInt(s.users), sessions30: fmtInt(s.sessions30), medianTokens: s.medianTokens == null ? null : fmtWan(s.medianTokens),
      medianCost: s.medianCost == null ? null : `$${s.medianCost.toFixed(2)}`, medianCostNum: s.medianCost == null ? null : s.medianCost.toFixed(2),
      p75Cost: s.p75Cost == null ? null : `$${s.p75Cost.toFixed(2)}`, _medianCost: s.medianCost };
  }, 'db');
  await tryIt(() => { const g = gitStats(); return { commits: fmtInt(g.commits), tests: floorHundredYu(g.tests) }; }, 'git');
  await tryIt(() => { const n = toolCount(); return n ? { tools: String(n) } : {}; }, 'tools');
  await tryIt(async () => {
    const q = await dailyQuota();
    const r = { dailyQuota: String(q) };
    if (out._medianCost > 0) r.quotaSessions = String(Math.floor(q / out._medianCost));
    return r;
  }, 'quota');
  delete out._medianCost;
  return out;
}

/** 把 data-stat 元素里的文字换成新值；值为空的键不动。回 { html, changed: [键] } */
export function applyStats(html, stats) {
  const changed = [];
  const out = html.replace(/(<(b|span|strong|em)\b[^>]*\bdata-stat="([a-zA-Z0-9]+)"[^>]*>)([^<]*)(<\/\2>)/g, (all, open, tag, key, text, close) => {
    const v = stats[key];
    if (v == null || v === '' || v === text) return all;
    changed.push(key);
    return `${open}${v}${close}`;
  });
  return { html: out, changed };
}

async function main() {
  if (!fs.existsSync(DIR)) { console.error(`[site-stats] 目录不存在：${DIR}`); process.exit(1); }
  const stats = await computeStats();
  console.log(`[site-stats] ${JSON.stringify(stats)}`);
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.html'))) {
    const p = path.join(DIR, f);
    const { html, changed } = applyStats(fs.readFileSync(p, 'utf8'), stats);
    if (!changed.length) continue;
    console.log(`[site-stats] ${f}: ${changed.join(', ')}`);
    if (DRY) continue;
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, html); fs.renameSync(tmp, p);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`[site-stats] ${e.stack || e.message}`); process.exit(1); });
}
