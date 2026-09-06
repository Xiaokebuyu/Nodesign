/**
 * auth/tier.test.js —— 档位真相源的两件事：
 *   1. 能力表本身（admin / pro / basic 各能干什么；null 用户 fail-closed；拼错能力名抛错）
 *   2. **lint**：全仓没人再拿旁路字段做权限判断。契约写在注释里拦不住任何人
 *      （[[feedback-contract-needs-a-lint]]），所以这里 grep 源码：
 *        - `.lifetimeCostLimitUsd` 只许 quota.js 读（它是花费上限，不是档位）
 *        - `.allowLocalGen` 只许 tier.js 读（逐人批准只在 localGenApproved 一处叠加）
 *        - `allowSubscription` / `allow_subscription` 退役，代码里不许再出现（users-store 迁移块除外）
 *        - 档位名字符串比较（`=== 'basic'` / `=== 'pro'`）只许 tier.js / users-store.js；
 *          消费方问能力不问档位（否则加第四档又要全仓 grep）
 *        - SDK 的 `query` 只许 session-loop.js import —— 订阅 OAuth 的唯一入口，
 *          quick-summary 那次泄漏（08-14 加 08-19 拆）就是第二个入口
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIERS, PLANS, CAPABILITY_NAMES, tierOf, can, defaultModerationLevel, webSearchDailyCap, localGenApproved, DENIAL, basicDefaultDailyUsd } from './tier.js';

const admin = { id: 'a', role: 'admin', plan: 'basic' };   // admin 的 plan 列无意义，role 派生
const pro = { id: 'p', role: 'user', plan: 'pro' };
const proApproved = { ...pro, allowLocalGen: true };
const basic = { id: 'b', role: 'user', plan: 'basic' };
const basicApproved = { ...basic, allowLocalGen: true };   // 批准位不能把 basic 抬起来
const legacyNoPlan = { id: 'l', role: 'user' };             // 没 plan 字段的对象 → basic（拼错/缺省落紧的一边）

describe('tierOf / can', () => {
  it('三档 + null', () => {
    expect(TIERS).toEqual(['admin', 'pro', 'basic']);
    expect(PLANS).toEqual(['pro', 'basic']);
    expect(tierOf(admin)).toBe('admin');
    expect(tierOf(pro)).toBe('pro');
    expect(tierOf(basic)).toBe('basic');
    expect(tierOf(legacyNoPlan)).toBe('basic');
    expect(tierOf({ role: 'user', plan: 'vip' })).toBe('basic');
    expect(tierOf(null)).toBeNull();
  });
  it('能力表：admin/pro 全开；basic = webSearch + imageGen（08-21 深夜开放，按张计价）；null 全关', () => {
    for (const cap of ['subscription', 'webSearch', 'imageGen', 'localGen', 'publishSite']) {
      expect(can(admin, cap), cap).toBe(true);
      expect(can(pro, cap), cap).toBe(true);
      expect(can(null, cap), cap).toBe(false);
      expect(can(basic, cap), cap).toBe(cap === 'webSearch' || cap === 'imageGen');
    }
    expect(CAPABILITY_NAMES).toContain('moderationDefault');
    expect(CAPABILITY_NAMES).toContain('moderationDefaultApi');
    expect(basicDefaultDailyUsd({})).toBe(5);
    expect(basicDefaultDailyUsd({ NODESIGN_BASIC_DEFAULT_DAILY_USD: '8' })).toBe(8);
    expect(basicDefaultDailyUsd({ NODESIGN_BASIC_DEFAULT_DAILY_USD: '0' })).toBeNull();
  });
  it('未知能力名抛错（拼错不能静默 false/true）', () => {
    expect(() => can(pro, 'imagegen')).toThrow(/unknown capability/);
  });
  it('外审默认档 · 订阅通路：admin off / pro strict / basic strict（08-21 晚「所有审查开到严格」）', () => {
    expect(defaultModerationLevel(admin)).toBe('off');
    expect(defaultModerationLevel(pro)).toBe('strict');
    expect(defaultModerationLevel(basic)).toBe('strict');
    expect(defaultModerationLevel(null)).toBe('strict');
  });
  it('⭐⭐ 外审默认档 · API 通路：三档一律 off（08-30 用户拍板「非 Claude 订阅的模型不审」）', () => {
    // 两栏合回一栏的话 pro/basic 这两句会拿到 strict —— 这就是它必须拦住的局面
    for (const u of [admin, pro, basic]) expect(defaultModerationLevel(u, 'api'), u.id).toBe('off');
    // null 用户仍然 fail-closed：没有账号可依据时不许落到更松的一边
    expect(defaultModerationLevel(null, 'api')).toBe('strict');
    // 旋钮名拼错 / 不给 → 落订阅那一边（同 moderationKnobFor 的口径：只能落紧的一边）
    expect(defaultModerationLevel(pro, 'aip')).toBe('strict');
    expect(defaultModerationLevel(pro)).toBe('strict');
  });
  it('web_search 日上限：只有 basic 有（默认 60，env 可调）；null 用户 0', () => {
    const saved = process.env.NODESIGN_BASIC_WEB_SEARCH_PER_DAY;
    delete process.env.NODESIGN_BASIC_WEB_SEARCH_PER_DAY;
    expect(webSearchDailyCap(admin)).toBeNull();
    expect(webSearchDailyCap(pro)).toBeNull();
    expect(webSearchDailyCap(basic)).toBe(60);
    expect(webSearchDailyCap(null)).toBe(0);
    process.env.NODESIGN_BASIC_WEB_SEARCH_PER_DAY = '5';
    expect(webSearchDailyCap(basic)).toBe(5);
    if (saved === undefined) delete process.env.NODESIGN_BASIC_WEB_SEARCH_PER_DAY; else process.env.NODESIGN_BASIC_WEB_SEARCH_PER_DAY = saved;
  });
  it('本地产线 = 档位资格 且 逐人批准：admin 免批、pro 要批、basic 批了也不行', () => {
    expect(localGenApproved(admin)).toBe(true);
    expect(localGenApproved(pro)).toBe(false);
    expect(localGenApproved(proApproved)).toBe(true);
    expect(localGenApproved(basic)).toBe(false);
    expect(localGenApproved(basicApproved)).toBe(false);
    expect(localGenApproved(null)).toBe(false);
  });
  it('拒绝话术齐全且是字符串', () => {
    for (const k of ['imageGen', 'imageQuota', 'localGenTier', 'localGenApproval', 'publishSite', 'subscription']) {
      expect(typeof DENIAL[k]).toBe('string');
      expect(DENIAL[k].length).toBeGreaterThan(8);
      expect(DENIAL[k]).not.toMatch(/邀请码|找站主|找管理员/);   // 口径：不给"去要码"的路径
    }
  });
});

// ── lint：旁路字段不许再当权限用 ──

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    // projects-data = 用户数据（含悬空软链），db = 库；都不是源码
    if (name === 'node_modules' || name === 'db' || name === 'projects-data' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, out);
    // `_` 开头 = 探针/体检脚本（_probe-*/_ingress-check），不是服务端源码
    else if (/\.(js|mjs)$/.test(name) && !/\.test\.js$/.test(name) && !/^_/.test(name)) out.push(p);
  }
  return out;
}
const FILES = walk(SERVER_ROOT);
const rel = (p) => path.relative(SERVER_ROOT, p).split(path.sep).join('/');
/** 整文件匹配版（跨行 import 块用），返回命中的文件名列表 */
function fileHits(re, allow = []) {
  return FILES.map(rel).filter((r) => !allow.includes(r) && re.test(readFileSync(path.join(SERVER_ROOT, r), 'utf8')));
}
/** 返回命中 (file:line) 列表，排除 allowlist 文件 */
function hits(re, allow = []) {
  const out = [];
  for (const f of FILES) {
    const r = rel(f);
    if (allow.includes(r)) continue;
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => { if (re.test(line)) out.push(`${r}:${i + 1}: ${line.trim()}`); });
  }
  return out;
}

describe('lint：权限判断只走 auth/tier.js', () => {
  it('扫到的文件数合理（walk 没扫空）', () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES.some((f) => rel(f) === 'auth/tier.js')).toBe(true);
  });
  it('.lifetimeCostLimitUsd 只许 quota.js 读（花费上限，不是档位）', () => {
    expect(hits(/\.lifetimeCostLimitUsd\b/, ['lib/quota.js'])).toEqual([]);
  });
  it('.allowLocalGen 只许 tier.js 读（逐人批准只在 localGenApproved 叠加）', () => {
    expect(hits(/\.allowLocalGen\b/, ['auth/tier.js'])).toEqual([]);
  });
  it('allowSubscription / allow_subscription 已退役（users-store 的列迁移块除外）', () => {
    expect(hits(/allowSubscription|allow_subscription/, ['auth/users-store.js'])).toEqual([]);
  });
  it("档位名字符串比较只许 tier.js / users-store.js（消费方问能力不问档位）", () => {
    // role==='admin' 是 role 判断（到处都有、合法），这里只盯 plan/tier 名
    expect(hits(/[!=]==\s*'(basic|pro)'|tierOf\([^)]*\)\s*[!=]==|\.plan\s*[!=]==/, ['auth/tier.js', 'auth/users-store.js'])).toEqual([]);
  });
  it("SDK 的 query 只许 session-loop.js（跑回合）与 sessions-rewind.js（回退，不跑回合）拿到 —— 订阅 OAuth 的入口就这两个", () => {
    // 整文件匹配（多行 import 块也抓）+ 命名空间 import + 动态 import 三种形态。
    // 评审 08-21 抓过：逐行正则对 sessions.js 的多行 import 假过。
    // 动态 import 只认 `await import(...)` / `= import(...)`；JSDoc 的 `{import('…sdk').Query}` 类型引用不算（active-runs.js 有一堆）
    const re = /import\s*\{[^}]*\bquery\b[^}]*\}\s*from\s*['"]@anthropic-ai\/claude-agent-sdk['"]|import\s*\*\s*as\s+\w+\s*from\s*['"]@anthropic-ai\/claude-agent-sdk['"]|(?:await|=)\s*import\(\s*['"]@anthropic-ai\/claude-agent-sdk['"]\s*\)/;
    // 08-30：回退那块从 api/sessions.js 拆去了 api/sessions-rewind.js（行数棘轮），
    // 持有 query 的换成了它 —— 白名单是**换**不是加，sessions.js 现在够不到 SDK。
    // 09-05：演出进程（engine/stage/session.js）是第三个入口 —— 它自己不做资格判断，
    // 起它的 manager.buildEnv 走的是同一道闸（订阅路 `can(owner, 'subscription')`，没资格不起），
    // 跟 session-loop 的 route 分支一字不差。这里是加不是换：主循环那两个照旧。
    expect(fileHits(re, ['engine/agent/session-loop.js', 'api/sessions-rewind.js', 'engine/stage/session.js'])).toEqual([]);
  });
});

// ── 口径 lint（08-21 深夜用户拍板）：pro 不再对外分发，全站不许再对用户说"找站主要邀请码"之类的话 ──
describe('lint：用户可见文案不许再引导去要邀请码', () => {
  const WEB_ROOT = path.resolve(SERVER_ROOT, '..', 'web', 'src');
  function walkWeb(dir, out = []) {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const p = path.join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { if (name !== 'admin') walkWeb(p, out); }   // admin 控制台是站主自己看的，可以提邀请码
      else if (/\.(js|jsx)$/.test(name) && !/\.test\.jsx?$/.test(name)) out.push(p);
    }
    return out;
  }
  const BAD = /找站主|找我要码|找管理员开通|要邀请码|邀请码账号|邀请码注册的账号|换正式邀请码|拿到邀请码/;
  it('server（非 admin/users-store/测试/探针）', () => {
    const allow = ['hosted/admin.js', 'auth/users-store.js'];
    expect(hits(BAD, allow)).toEqual([]);
  });
  it('web/src（admin 目录除外；AdminConsole.jsx 的邀请码 UI 除外）', () => {
    const bad = [];
    for (const f of walkWeb(WEB_ROOT)) {
      if (/AdminConsole\.jsx$/.test(f)) continue;
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => { if (BAD.test(line)) bad.push(`${path.relative(WEB_ROOT, f)}:${i + 1}: ${line.trim().slice(0, 100)}`); });
    }
    expect(bad).toEqual([]);
  });
});
