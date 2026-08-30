/**
 * server/lib/quota.js — 每用户日用量限额（2026-07-30 内测；07-31 口径改成金额）
 *
 * # 为什么闸门数的是钱不是 token
 *
 * 原口径是 sum(input_tokens + output_tokens)，缓存不计。实测这个口径量错了主项：
 * 07-31 当天全站 input+output 是 317k，cache_read 是 83M，差 260 倍。也就是说
 * 配额条显示"才用了 4%"的人，实际推给账号的负载可能已经是一整天的大头。
 *
 * 更要命的是**缓存过期**。同一轮对话，缓存全命中和全过期的 token 计数几乎一样，
 * 但过期后那批 token 从 $0.30/M 的 cache_read 变成 $3/M 的 input，还要再花
 * $6.00/M 重写一次缓存，金额能差十倍。token 口径对这件事完全瞎。
 *
 * SDK 的 `ModelUsage.costUSD` 是原生字段，CLI 内部按分模型价目表算好给出来的。
 * 逆推验证精确到小数点后 7 位：
 *   9703×$3/M + 39032×$15/M + 6032461×$0.30/M + 414101×$6.00/M = $4.9089333
 *   （SDK 报 4.908933300000001；haiku 行 532×$1/M + 17×$5/M 也精确命中）
 * 缓存过期的代价自动体现在里面 —— 失效后 API 逐请求如实上报 input/cache_read
 * 的实际拆分，costUSD 照单算，不需要我们建模 TTL 或命中率。
 *
 * # 数据源必须是 run_model_usage.cost_usd，不能是 runs.total_cost_usd
 *
 * runs 那列有历史污染：07-31 计量重做之前，写进去的是 SDK 的**会话累计**
 * total_cost_usd（同一会话每轮都存一次当时的累计值），admin 的存量行因此虚高
 * 三倍（$165 vs 实际 $53.6）。run_model_usage 是重做后新建的表，只由差分路径
 * 写入，两个真人用户的行都跟公式精确对齐。
 *
 * # 口径覆盖范围
 *
 * 包含：该会话所有模型的 input / output / cache_read / cache_create，含子代理
 * sidechain（Miel 从没手选过 haiku，她的 haiku 行是子代理自己用的，照样进账）。
 * 不含：生图（codex 骑订阅）、web_search（Tavily/百度/Exa/智谱各自的账单）、
 * 机器本身。所以这个数字的准确定义是「该用户对 Anthropic 账号造成的负载」，
 * 恰好就是我们要配给的东西。
 *
 * 限额来源：users.daily_cost_limit_usd 优先，NULL 走 env NODESIGN_USER_DAILY_USD
 * （默认 $5）。admin 不限。按 Asia/Shanghai 日界滚动现算，没有定时任务。
 */

import { readFileSync } from 'node:fs';
import db, { getRun } from '../engine/runs/store.js';
import { countRunningTurns, listRunningTurnRunIds } from '../engine/runs/active-runs.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;   // Asia/Shanghai，内测口径写死

/** 当天（+08:00 日界）的 UTC 起点，格式对齐 SQLite datetime('now') */
export function dayStartUtcSql(now = Date.now()) {
  const startLocal = Math.floor((now + TZ_OFFSET_MS) / DAY_MS) * DAY_MS - TZ_OFFSET_MS;
  return new Date(startLocal).toISOString().slice(0, 19).replace('T', ' ');
}

/** 当天已花的美元（闸门真口径）。数据源见文件头：run_model_usage.cost_usd */
export function usedCostToday(userId, now = Date.now()) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(m.cost_usd), 0) AS used
     FROM run_model_usage m JOIN runs r ON r.id = m.run_id
     WHERE r.user_id = ? AND r.created_at >= ?`,
  ).get(userId, dayStartUtcSql(now));
  return row.used;
}

/** 全史花费（终身额度口径）。同一数据源同一公式，只是不设日界 */
export function usedCostTotal(userId) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(m.cost_usd), 0) AS used
     FROM run_model_usage m JOIN runs r ON r.id = m.run_id
     WHERE r.user_id = ?`,
  ).get(userId);
  return row.used;
}

/**
 * 当天 input+output token 数。**不再是闸门口径**，只留给 admin 视图和
 * 前端的参考行 —— 用户看得懂 token，看不懂 $0.87 意味着多少对话。
 */
export function usedTokensToday(userId, now = Date.now()) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)), 0) AS used
     FROM runs WHERE user_id = ? AND created_at >= ?`,
  ).get(userId, dayStartUtcSql(now));
  return row.used;
}

/**
 * 默认日额度（美元）。
 *
 * $15 的依据是 07-31 晚上第一个真用户的实际曲线：Miel 一小时零四分跑了 32 轮，
 * 烧掉 $6.60，约 $6/小时（速率随会话变长而涨 —— 上下文越长每轮读的缓存越多）。
 * 一晚上三小时的热情使用就是 $18 量级。
 *
 * 先按 $5 配过，实测下来那个数会在她玩到一半时把人挡在外面 —— 而她正是唯一
 * 越过冷启动的人。日限额的职责是拦住失控，不是给正常使用配给；卡到最活跃的
 * 那个人身上，说明数字定错了，不是人用多了。
 *
 * 参照：admin 重度开发日 $1.03/轮 × 52 轮 = $53.6（自己不限额）。
 */
export function defaultDailyLimit() {
  const v = Number(process.env.NODESIGN_USER_DAILY_USD);
  return Number.isFinite(v) && v > 0 ? v : 15;
}

/** 生图按张计价（08-21 深夜，basic 开放生图）：每张记 $0.20 进本回合账，跟模型花费同一本、同一把日限尺。env NODESIGN_IMAGE_PRICE_USD */
export function imageChargeUsd(env = process.env) {
  const v = Number(env.NODESIGN_IMAGE_PRICE_USD);
  return Number.isFinite(v) && v >= 0 ? v : 0.2;
}

/** @returns {number|null} 美元；null = 不限（admin） */
export function limitFor(user) {
  if (!user || user.role === 'admin') return null;
  return user.dailyCostLimitUsd ?? defaultDailyLimit();
}

/** 金额展示：$1.36。小额也留两位小数，别把 $0.06 显示成 $0 让人以为没扣 */
export function fmtUsd(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

/**
 * 额度检查。两种口径（08-02 起）：
 *   daily    — 默认。+08:00 日界滚动，隔天刷新（内测熟人号）。
 *   lifetime — users.lifetime_cost_limit_usd 非空即生效：全史花费封顶，
 *              永不刷新。给简历上的通用邀请码用（注册时从
 *              invites.grant_lifetime_usd 复制到用户身上，与码解耦）。
 *              终身口径**取代**日限不叠加 —— HR 试用要的是当晚完整体验，
 *              细水长流反而是坏体验；单号封顶 $15 本身就是敞口上限。
 *
 * `used` 是与 limit 同口径的比较数（终身号 = 全史）；`usedToday` 恒为当日数，
 * 展示层要"今天花了多少"时不用管口径。
 *
 * @returns {{ ok, kind: 'unlimited'|'daily'|'lifetime', used, limit, usedToday }} 单位美元
 */
export function checkQuota(user, now = Date.now()) {
  const usedToday = usedCostToday(user?.id, now);
  if (!user || user.role === 'admin') {
    return { ok: true, kind: 'unlimited', used: usedToday, limit: null, usedToday };
  }
  if (user.lifetimeCostLimitUsd != null) {
    const used = usedCostTotal(user.id);
    return { ok: used < user.lifetimeCostLimitUsd, kind: 'lifetime', used, limit: user.lifetimeCostLimitUsd, usedToday };
  }
  const limit = user.dailyCostLimitUsd ?? defaultDailyLimit();
  return { ok: usedToday < limit, kind: 'daily', used: usedToday, limit, usedToday };
}

/**
 * 免费模型的闸（08-21）：金额对 $0 的模型没有意义，免费档按**当日轮次**封顶 + 并发闸
 * （checkConcurrency 不变）。数据源 runs.created_at（同 usedCostToday 的日界）。
 * 口径：数的是该账号今天**所有**轮次，不按模型分 —— 公开注册号只能跑免费模型，
 * 邀请码号跑免费模型时也照这个数（订阅额度是另一把尺，互不抵扣）。
 * 上限 .env NODESIGN_FREE_DAILY_TURNS，默认 300；admin 不限。
 */
export function freeDailyTurnLimit() {
  const v = Number(process.env.NODESIGN_FREE_DAILY_TURNS);
  return Number.isFinite(v) && v > 0 ? v : 300;
}
export function usedTurnsToday(userId, now = Date.now()) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM runs WHERE user_id = ? AND created_at >= ?').get(userId, dayStartUtcSql(now));
  return row.n;
}
export function checkFreeQuota(user, now = Date.now()) {
  const used = usedTurnsToday(user?.id, now);
  if (!user || user.role === 'admin') return { ok: true, kind: 'unlimited', used, limit: null };
  const limit = freeDailyTurnLimit();
  return { ok: used < limit, kind: 'free-turns', used, limit };
}

// ── 分模型明细（2026-07-31）──
//
// **只用于展示，不再是独立闸门。** 改成金额口径之后，分模型限额失去了理由：
// 原来配 sonnet 300k / opus 100k 是为了让 opus 更难挥霍，而金额天然做到这件事
// —— 同样一轮对话 opus 就是烧掉五倍预算，不需要第二个数字去表达同一个意图。
// 代价是没了"这个模型满了可以换那个继续"的退路，撞线就是撞线；换来的是用户
// 只需要理解一个数字，以及不会出现"opus 额度还剩很多但钱其实早花光了"的错位。
//
// 家族归并按模型串关键字：表里存的是 SDK 上报的原始模型名（'claude-sonnet-5'），
// 用户视角只有 Sonnet / Opus 两个选项，版本号是实现细节。
// 注意：如果哪天重开 kimi gateway，SDK 上报的是 spoof 后的 opus 名，
// 这里会把 kimi 记成 opus —— 见 model-context.js APP_TO_SDK_MODEL。

export function modelFamily(model) {
  const s = String(model || '').toLowerCase();
  if (s.includes('sonnet')) return 'sonnet';
  if (s.includes('opus')) return 'opus';
  if (s.includes('haiku')) return 'haiku';
  return 'other';
}

/** 家族显示名（429 文案 / 前端徽标共用） */
export function familyLabel(family) {
  return { sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku' }[family] || family;
}

/**
 * 当天该用户按家族聚合的花费与 token，如
 * `{ sonnet: { costUsd: 1.36, tokens: 18831 }, haiku: { costUsd: 0, tokens: 549 } }`
 * 只有真出现过的家族才有键（没用过 opus 就没有 opus 键）。
 */
export function usedTodayByFamily(userId, now = Date.now()) {
  const rows = db.prepare(
    `SELECT m.model AS model,
            SUM(m.cost_usd) AS cost,
            SUM(m.input_tokens + m.output_tokens) AS tokens
     FROM run_model_usage m JOIN runs r ON r.id = m.run_id
     WHERE r.user_id = ? AND r.created_at >= ?
     GROUP BY m.model`,
  ).all(userId, dayStartUtcSql(now));
  const byFamily = {};
  for (const row of rows) {
    const f = modelFamily(row.model);
    const acc = byFamily[f] || (byFamily[f] = { costUsd: 0, tokens: 0 });
    acc.costUsd += row.cost || 0;
    acc.tokens += row.tokens || 0;
  }
  return byFamily;
}

// ── 并发闸门 ──
// 语义是"拒绝返 429"而不是"排队 await"：turn.js 是 202 fire-and-forget，
// 闸门必须在 202 之前同步判。同 session 追加消息走既有排队语义不经这里。
//
// 08-21 经营态转向后分两档：
// - 订阅行（花站主的订阅）：全局固定数 NODESIGN_MAX_CONCURRENT_RUNS（默认 3）
// - 非订阅行（走 ingress 的 API 行）：不受全局固定数限制。它的约束只剩机器本身 ——
//   每个 claude CLI 进程 350MB~1GB、机器 1 vCPU/8G 无 swap，所以改成**内存闸**：
//   MemAvailable 低于 NODESIGN_MIN_FREE_MEM_MB（默认 700）就拒，外加一个防失控的
//   上限 NODESIGN_FREE_MAX_CONCURRENT_RUNS（默认 12）。内存闸对两档都生效（订阅行
//   的固定数 3 本来就是按内存拍的，内存先见底时固定数也救不了）
// - 每用户同时 1 个（admin 免）两档都一样：这是公平性不是资源
//
// ⭐⭐ **2026-08-30 判据从「免费/付费」改成「订阅/非订阅」**。起因：全员默认行换成
// glm-5.3-flash-merge（付费但极便宜，$0.015/M）。按老判据它落进"付费"那一档，站点默认
// 路径的并发天花板会从 12 掉到 3，而这台盒子实测峰值在飞 turn 是 4 —— 第 4 个人当场
// 吃「现在有点挤」。
// 这不是把闸放松，是**把闸对准它本来护的东西**：那个 3 从头到尾护的是站主的 Claude 订阅
// （同时开太多 query 会烧额度、也会被上游限流），跟"这一轮花不花钱"没有关系。一条
// $0.015/M 的网关行既不烧订阅、也不烧机器以外的任何东西，它该受的约束就是内存。
// ⚠️ 于是**付费的 API 行现在也走 12 + 内存闸**（deepseek 视觉行、merge 行）。真要给某一家
// 单独收并发，那是 per-upstream 的闸，不是把它塞回订阅那一档。

export function memAvailableMb() {
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync('/proc/meminfo', 'utf8'));
    return m ? Math.floor(Number(m[1]) / 1024) : null;
  } catch { return null; }   // 非 Linux / 读不到 → 不以内存拒
}

/**
 * 纯决策：输入全是数，方便测。
 * @param {boolean} offSubscription 这一轮**不花站主订阅**（走 ingress 的 API 行）。
 *   ⚠️ 08-30 前这个参数叫 `free`、判据是"模型免不免费"，改名是因为那个名字骗过人一次：
 *   默认行换成一条付费但极便宜的 API 行时，它被判进订阅那一档、天花板从 12 掉到 3。
 */
export function decideConcurrency({ running, mine, isAdmin, offSubscription, free, memMb, env = process.env }) {
  // 老参数名还认（旧调用方 / 测试），但新名优先
  const offSub = offSubscription !== undefined ? offSubscription : !!free;
  const minMem = Number(env.NODESIGN_MIN_FREE_MEM_MB) || 700;
  if (memMb != null && memMb < minMem) {
    return { ok: false, code: 'BUSY', message: `机器内存快满了（${running} 个任务在跑），稍等一会儿再发` };
  }
  const globalMax = offSub
    ? (Number(env.NODESIGN_FREE_MAX_CONCURRENT_RUNS) || 12)
    : (Number(env.NODESIGN_MAX_CONCURRENT_RUNS) || 3);
  if (running >= globalMax) {
    return { ok: false, code: 'BUSY', message: `现在有点挤（${running} 个任务在跑），稍等一会儿再发` };
  }
  if (!isAdmin) {
    const perUser = Number(env.NODESIGN_USER_CONCURRENT_RUNS) || 1;
    if (mine >= perUser) {
      return { ok: false, code: 'BUSY', message: '你有任务正在跑，等它完成再开下一个（同一对话里追加消息不受限）' };
    }
  }
  return { ok: true };
}

export function checkConcurrency(user, { offSubscription = false, free = false } = {}) {
  // running turn → user 归属：runId 查 runs.user_id（不给 session 注册表加
  // userId 字段 —— 正在跑的 turn 就几个，查表成本可忽略）
  let mine = 0;
  if (user?.role !== 'admin') {
    for (const rid of listRunningTurnRunIds()) {
      if (getRun(rid)?.userId === user?.id) mine += 1;
    }
  }
  return decideConcurrency({
    running: countRunningTurns(), mine, isAdmin: user?.role === 'admin',
    offSubscription: offSubscription || free, memMb: memAvailableMb(),
  });
}
