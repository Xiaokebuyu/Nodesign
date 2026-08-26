/**
 * server/auth/users-store.js — 用户与邀请码（2026-07-30 内测多用户）
 *
 * 复用 engine/runs/store.js 的 better-sqlite3 连接（与 projects/runs 同一个
 * nodesign.db）。建表走仓里的既有范式：import 副作用式幂等 DDL。
 *
 * 密码：node 内置 crypto.scrypt，无新依赖。存储格式
 *   scrypt$<N>$<saltHex>$<hashHex>
 * 参数变更时旧记录仍能按自记录的 N 校验。
 *
 * 邀请码：admin 生成，限次数/可过期；注册时事务内 used_count+1 防并发超发。
 *
 * bootstrapAuth()（index.js 启动时调，幂等）：
 *   - users 空 && NODESIGN_AUTH_PASSWORD 存在 → 用该密码建 admin 账号
 *     （单密码墙 → 多用户的无感迁移：你用老密码 + 用户名 admin 重登即可）
 *   - projects.owner_id 为 NULL 的存量行 → 回填 admin（历史项目全归你）
 */

import crypto from 'node:crypto';
import db from '../engine/runs/store.js';
import { PLANS, basicDefaultDailyUsd } from './tier.js';
import { LOCALES } from '../shared/locales.js';
import { platform } from '../runtime/platform.js';

/**
 * 登录墙关闭时的请求者（HTTP / WS / 工具内 owner 反查三处共用同一个对象）。
 * 形状对齐 rowToUser：role admin ⇒ tier admin ⇒ 全能力、免额度、免外审；没有 plan /
 * moderationLevel ⇒ 档位默认值。id 进 projects.owner_id / runs.user_id 这些列，所以
 * 必须稳定不变 —— 改了它，老项目在本地版里会「找不到」。
 */
export const LOCAL_OWNER = Object.freeze({ id: '_anon', username: 'anon', role: 'admin', dailyTokenLimit: null, disabled: false });

/**
 * 登录墙是否启用。
 *   - local profile：钉死关闭（单租户；服务只绑环回，见 runtime/profile.js）。users 表里有没有行都不看 ——
 *     开发者用同一个 DB 切过 profile 也不会突然被一堵墙拦住。
 *   - hosted：有用户就启用；一个用户都没有且没密码 = 关闭（本地开发）。
 */
export function authEnabled() {
  if (platform.isLocal) return false;
  return countUsers() > 0 || (process.env.NODESIGN_AUTH_PASSWORD || '').length > 0;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    daily_token_limit INTEGER,
    disabled INTEGER NOT NULL DEFAULT 0,
    invite_code TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY,
    created_by TEXT,
    max_uses INTEGER NOT NULL DEFAULT 1,
    used_count INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// 老 DB 补列（幂等，同 projects/store.js 范式）：07-31 限额口径从 token 换成
// 金额，per-user 覆盖也跟着换单位。daily_token_limit 保留不删 —— 它是老口径的
// 存量数据，删了就没法回溯当时给谁开过什么口子。
const userCols = new Set(db.prepare('PRAGMA table_info(users)').all().map(c => c.name));
if (!userCols.has('daily_cost_limit_usd')) {
  db.exec('ALTER TABLE users ADD COLUMN daily_cost_limit_usd REAL');
  console.log('[users-store] users.daily_cost_limit_usd column added');
}

// 08-02 试用账号（简历上的通用邀请码）：终身额度，烧满不刷新。非空即生效，
// 且**取代**日限而不是叠加 —— 试用要的是完整体验一晚，不是细水长流。
// 注册时从 invites.grant_lifetime_usd 复制过来，之后改码删码不影响已注册的号。
if (!userCols.has('lifetime_cost_limit_usd')) {
  db.exec('ALTER TABLE users ADD COLUMN lifetime_cost_limit_usd REAL');
  console.log('[users-store] users.lifetime_cost_limit_usd column added');
}
// 08-02 内容外审强度（见 lib/moderation.js）：'off' | 'loose' | 'strict'。
// NULL = 跟随该账号的默认档（试用号 strict / 正式号 loose / admin off），
// 站主可 per-user 覆盖。列存的是覆盖值，不是最终值 —— 默认档改了，
// 没设过的号跟着走。
if (!userCols.has('moderation_level')) {
  db.exec('ALTER TABLE users ADD COLUMN moderation_level TEXT');
  console.log('[users-store] users.moderation_level column added');
}
// 08-20 外审档按模型通路拆成两个旋钮：moderation_level 只管订阅模型（Sonnet/Opus，
// 跑在站主账号上），moderation_level_api 管本地 qwen / 中转站那些走 ingress 的 API 行。
// 站主要的是"给朋友开 qwen 无审查"不必顺带放开 Sonnet、"收紧 Sonnet"不必顺带收紧 qwen。
// 迁移口径：已显式设过档位的号把现值**复制**进 API 旋钮 —— 迁移当天谁的行为都不变
// （否则昨天为 qwen 设了 off 的朋友，今天 qwen 突然变 loose），之后站主按人调。
if (!userCols.has('moderation_level_api')) {
  db.exec('ALTER TABLE users ADD COLUMN moderation_level_api TEXT');
  const n = db.prepare('UPDATE users SET moderation_level_api = moderation_level WHERE moderation_level IS NOT NULL').run().changes;
  console.log(`[users-store] users.moderation_level_api column added (copied ${n} explicit level(s) from moderation_level)`);
}
// 本地产线（roll_film/paint_still）批准制：admin 天生有，其余账号站主点开才有
if (!userCols.has('local_gen')) {
  db.exec('ALTER TABLE users ADD COLUMN local_gen INTEGER NOT NULL DEFAULT 0');
  console.log('[users-store] users.local_gen column added');
}
// 08-21 经营态转向：订阅 Claude 资格按账号发。新列默认 0（公开注册号只能用免费模型），
// **迁移时把已有用户全部置 1**（老号保留，用户说他手动关）；邀请码注册的号拿 1。
if (!userCols.has('allow_subscription')) {
  db.exec('ALTER TABLE users ADD COLUMN allow_subscription INTEGER NOT NULL DEFAULT 0');
  const n = db.prepare('UPDATE users SET allow_subscription = 1').run().changes;
  console.log(`[users-store] users.allow_subscription column added（存量 ${n} 个账号置 1）`);
}
// 08-21 晚 账号档位真相源（auth/tier.js）：users.plan ∈ 'pro' | 'basic'，admin 由 role 派生。
// 取代 allow_subscription 那个单能力布尔 —— 订阅资格、生图、发布、外审默认档全从档位派生，
// 消费方问能力不问字段。迁移口径一比一复制（allow_subscription=1 → pro，0 → basic），
// 迁移当天谁的行为都不变。allow_subscription 列**退役**：不读不写，留着只是 SQLite 不爱删列。
if (!userCols.has('plan')) {
  db.exec("ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'basic'");
  const n = db.prepare("UPDATE users SET plan = 'pro' WHERE allow_subscription = 1").run().changes;
  console.log(`[users-store] users.plan column added（${n} 个账号按 allow_subscription 迁成 pro，其余 basic）`);
}
// 08-26 i18n：界面语言偏好。NULL = 没表过态（前端落浏览器语言），'zh-CN' / 'en' = 显式选过。
// 不给 NOT NULL DEFAULT：存量账号必须是"没表过态"，不能被当成选了中文 —— 一个用惯英文
// 浏览器的老用户下次进来该看见英文，而不是被这次迁移钉死在中文上。
if (!userCols.has('locale')) {
  db.exec('ALTER TABLE users ADD COLUMN locale TEXT');
  console.log('[users-store] users.locale column added');
}

const inviteCols = new Set(db.prepare('PRAGMA table_info(invites)').all().map(c => c.name));
if (!inviteCols.has('grant_lifetime_usd')) {
  db.exec('ALTER TABLE invites ADD COLUMN grant_lifetime_usd REAL');
  console.log('[users-store] invites.grant_lifetime_usd column added');
}

// ── 密码 ──

const SCRYPT_N = 16384;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64, { N: SCRYPT_N, r: 8, p: 1 }).toString('hex');
  return `scrypt$${SCRYPT_N}$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const m = /^scrypt\$(\d+)\$([0-9a-f]+)\$([0-9a-f]+)$/.exec(stored || '');
  if (!m) return false;
  const [, nStr, salt, hashHex] = m;
  try {
    const calc = crypto.scryptSync(String(password), salt, hashHex.length / 2, { N: Number(nStr), r: 8, p: 1 });
    return crypto.timingSafeEqual(calc, Buffer.from(hashHex, 'hex'));
  } catch {
    return false;
  }
}

// ── 用户 ──

const USERNAME_RE = /^[A-Za-z0-9_一-鿿-]{2,32}$/;

export function validUsername(name) {
  return typeof name === 'string' && USERNAME_RE.test(name);
}

function newUserId() {
  return `u_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    dailyCostLimitUsd: row.daily_cost_limit_usd ?? null,
    lifetimeCostLimitUsd: row.lifetime_cost_limit_usd ?? null,
    dailyTokenLimit: row.daily_token_limit ?? null,   // 老口径存量，只读不用
    moderationLevel: row.moderation_level ?? null,    // 订阅模型的外审档；null = 跟随默认档
    moderationLevelApi: row.moderation_level_api ?? null,  // 本地 qwen / 中转站的外审档；null = 跟随默认档
    allowLocalGen: !!row.local_gen,                   // 本地产线逐人批准（叠在档位之上；见 auth/tier.js localGenApproved）
    plan: row.plan === 'pro' ? 'pro' : 'basic',       // 档位真相源：pro（邀请码）| basic（公开注册）；admin 看 role。能力问 auth/tier.js
    disabled: !!row.disabled,
    locale: row.locale || null,                      // 界面语言偏好；null = 没表过态，前端落浏览器语言
    inviteCode: row.invite_code || null,
    createdAt: row.created_at,
  };
}

// requestUser 每个请求都要查 —— 60s 内存缓存压掉热路径的 SQLite 读。
// disable 用户最迟 60s 生效，内测语境可接受。
const userCache = new Map();   // id → { user, at }
const USER_CACHE_MS = 60_000;

export function getUserById(id) {
  // 登录墙关闭时 owner 是 LOCAL_OWNER，它不在表里。不在这里接住，session-loop 的订阅资格断言 /
  // tier-gate / paint_still 这些按 ownerId 反查的地方会拿到 null ⇒ fail-closed ⇒ 本地版什么都跑不了。
  // 登录墙开着时 '_anon' 不是合法身份（表里没有这行），照常查表得 null。
  if (id === LOCAL_OWNER.id && !authEnabled()) return LOCAL_OWNER;
  const hit = userCache.get(id);
  if (hit && Date.now() - hit.at < USER_CACHE_MS) return hit.user;
  const user = rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  userCache.set(id, { user, at: Date.now() });
  return user;
}

export function getUserByUsername(username) {
  return rowToUser(db.prepare('SELECT * FROM users WHERE username = ?').get(username));
}

/** 登录用：要拿 hash 比对，不走 rowToUser（hash 不出模块） */
export function getCredential(username) {
  const row = db.prepare('SELECT id, password_hash, disabled FROM users WHERE username = ?').get(username);
  return row ? { id: row.id, passwordHash: row.password_hash, disabled: !!row.disabled } : null;
}

export function createUser({ username, password, role = 'user', inviteCode = null, lifetimeCostLimitUsd = null, dailyCostLimitUsd = null, plan = 'basic' }) {
  if (!PLANS.includes(plan)) throw new Error(`createUser: plan 需为 ${PLANS.join('/')}，收到 '${plan}'`);
  const id = newUserId();
  db.prepare(`INSERT INTO users (id, username, password_hash, role, invite_code, lifetime_cost_limit_usd, daily_cost_limit_usd, plan) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, username, hashPassword(password), role, inviteCode, lifetimeCostLimitUsd, dailyCostLimitUsd, plan);
  return getUserById(id);
}

export function listUsers() {
  return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all().map(rowToUser);
}

export function updateUser(id, { disabled, dailyTokenLimit, dailyCostLimitUsd, lifetimeCostLimitUsd, role, moderationLevel, moderationLevelApi, localGen, plan, locale } = {}) {
  const sets = [];
  const args = [];
  if (disabled !== undefined) { sets.push('disabled = ?'); args.push(disabled ? 1 : 0); }
  if (moderationLevel !== undefined) { sets.push('moderation_level = ?'); args.push(moderationLevel ?? null); }
  if (moderationLevelApi !== undefined) { sets.push('moderation_level_api = ?'); args.push(moderationLevelApi ?? null); }
  if (localGen !== undefined) { sets.push('local_gen = ?'); args.push(localGen ? 1 : 0); }
  if (locale !== undefined) {
    if (locale !== null && !LOCALES.includes(locale)) throw new Error(`updateUser: locale 需为 ${LOCALES.join('/')} 或 null，收到 '${locale}'`);
    sets.push('locale = ?'); args.push(locale ?? null);
  }
  if (plan !== undefined) {
    if (!PLANS.includes(plan)) throw new Error(`updateUser: plan 需为 ${PLANS.join('/')}，收到 '${plan}'`);
    sets.push('plan = ?'); args.push(plan);
  }
  if (dailyCostLimitUsd !== undefined) { sets.push('daily_cost_limit_usd = ?'); args.push(dailyCostLimitUsd ?? null); }
  if (lifetimeCostLimitUsd !== undefined) { sets.push('lifetime_cost_limit_usd = ?'); args.push(lifetimeCostLimitUsd ?? null); }
  if (dailyTokenLimit !== undefined) { sets.push('daily_token_limit = ?'); args.push(dailyTokenLimit ?? null); }
  if (role !== undefined) { sets.push('role = ?'); args.push(role); }
  if (!sets.length) return getUserById(id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  userCache.delete(id);
  return getUserById(id);
}

export function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

// ── 邀请码 ──

export function createInvite({ createdBy = null, maxUses = 1, expiresAt = null, grantLifetimeUsd = null } = {}) {
  // 可读形态：nd-xxxxxxxx（发群里手输不痛苦；去掉易混字符）
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let code = 'nd-';
  for (const b of crypto.randomBytes(8)) code += alphabet[b % alphabet.length];
  db.prepare('INSERT INTO invites (code, created_by, max_uses, expires_at, grant_lifetime_usd) VALUES (?, ?, ?, ?, ?)')
    .run(code, createdBy, maxUses, expiresAt, grantLifetimeUsd);
  return getInvite(code);
}

export function getInvite(code) {
  return db.prepare('SELECT * FROM invites WHERE code = ?').get(code) || null;
}

/**
 * 改邀请码的可用次数（控制台用）。语义是**总次数**不是剩余次数 ——
 * 改到 ≤ used_count 等于立即封死这个码（简历码泄漏时的一键止血）。
 */
export function updateInvite(code, { maxUses } = {}) {
  if (maxUses !== undefined) {
    db.prepare('UPDATE invites SET max_uses = ? WHERE code = ?').run(maxUses, code);
  }
  return getInvite(code);
}

export function listInvites() {
  return db.prepare('SELECT * FROM invites ORDER BY created_at DESC').all();
}

/** 开放注册开关（.env NODESIGN_OPEN_REGISTRATION=1）。关着时没邀请码照旧拒 */
export function openRegistrationEnabled() {
  return /^(1|true|yes)$/i.test(String(process.env.NODESIGN_OPEN_REGISTRATION || ''));
}

/** 邀请码注册的号默认**每日**额度（美元，08-21 晚用户拍板 $20）。env NODESIGN_INVITE_DEFAULT_DAILY_USD；0 或非法 = 不写（走全局默认日限） */
export function defaultInviteDailyUsd(env = process.env) {
  const raw = env.NODESIGN_INVITE_DEFAULT_DAILY_USD;
  if (raw === undefined || raw === '') return 20;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * 注册主流程（08-21 起两条路）：
 *   - 带邀请码：校验 + 消耗 + 建用户，落 **pro 档**（plan='pro'）+ 每日 $20（默认）+ 码上的终身额度（写了才有，取代日限）
 *   - 不带邀请码：开放注册开着才放行，落 **basic 档**（plan='basic'：只能用免费模型/搜索，
 *     不开生图、不开发布；能力表在 auth/tier.js）
 * 单事务（used_count+1 与 INSERT 原子，两人同抢最后一个名额只有一个成）。失败抛带 .code 的 Error。
 */
export const registerUser = db.transaction(({ username, password, inviteCode }) => {
  if (!validUsername(username)) {
    throw Object.assign(new Error('用户名 2-32 位，仅限字母数字下划线连字符和中文'), { code: 'BAD_USERNAME' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw Object.assign(new Error('密码至少 8 位'), { code: 'BAD_PASSWORD' });
  }
  if (getUserByUsername(username)) {
    throw Object.assign(new Error('用户名已被使用'), { code: 'USERNAME_TAKEN' });
  }
  const code = String(inviteCode || '').trim();
  if (!code) {
    if (!openRegistrationEnabled()) throw Object.assign(new Error('邀请码无效'), { code: 'BAD_INVITE' });
    // basic：每人每天 $5 总额度（Go 付费行按表价 + 生图 $0.20/张 同一本账；Ox 免费行不计）
    return createUser({ username, password, role: 'user', inviteCode: null, plan: 'basic', dailyCostLimitUsd: basicDefaultDailyUsd() });
  }
  const inv = getInvite(code);
  if (!inv) throw Object.assign(new Error('邀请码无效'), { code: 'BAD_INVITE' });
  if (inv.expires_at && new Date(inv.expires_at).getTime() < Date.now()) {
    throw Object.assign(new Error('邀请码已过期'), { code: 'INVITE_EXPIRED' });
  }
  if (inv.used_count >= inv.max_uses) {
    throw Object.assign(new Error('邀请码已用完'), { code: 'INVITE_EXHAUSTED' });
  }
  db.prepare('UPDATE invites SET used_count = used_count + 1 WHERE code = ?').run(inv.code);
  return createUser({
    username, password, role: 'user', inviteCode: inv.code,
    // 花费上限（不是档位）：终身额度只在码上写了才有（非空即取代日限）；日限默认 $20（08-21 晚起，以前跟全局默认 $50）
    lifetimeCostLimitUsd: inv.grant_lifetime_usd ?? null,
    dailyCostLimitUsd: defaultInviteDailyUsd(),
    plan: 'pro',
  });
});

// ── 启动 bootstrap（index.js 调，幂等）──

export function bootstrapAuth() {
  let admin = db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at ASC").get();
  if (!admin && countUsers() === 0) {
    const pw = process.env.NODESIGN_AUTH_PASSWORD || '';
    if (pw) {
      const created = createUser({ username: 'admin', password: pw, role: 'admin' });
      admin = db.prepare('SELECT * FROM users WHERE id = ?').get(created.id);
      console.log('[auth] bootstrap: 用 NODESIGN_AUTH_PASSWORD 创建了 admin 账号（用户名 admin）');
    } else {
      console.warn('[auth] users 表为空且未配置 NODESIGN_AUTH_PASSWORD —— 登录墙关闭（仅限本地开发）');
    }
  }
  if (admin) {
    // 存量项目回填归属（owner_id 列由 projects/store.js 幂等 ALTER 加上）
    const r = db.prepare('UPDATE projects SET owner_id = ? WHERE owner_id IS NULL').run(admin.id);
    if (r.changes > 0) console.log(`[auth] bootstrap: ${r.changes} 个存量项目归属到 admin`);
  }
  return admin ? rowToUser(admin) : null;
}
