/**
 * server/auth/users-store.js — 用户表的**读侧**（内核）：建表、LOCAL_OWNER、登录墙开关、按 id/用户名查、改字段。
 *
 * 写侧（密码哈希、建号、邀请码、注册、启动 bootstrap）在 server/hosted/users-write.js —— 那些只有多用户站
 * 才有，本地分发版（单租户，请求者恒为 LOCAL_OWNER）根本没有"注册"这回事，客户端包里也不带 hosted/。
 * 09-06 拆的；拆之前这一个文件两边都装，客户端跟着带走了整套注册和邀请码逻辑。
 *
 * 复用 engine/runs/store.js 的 better-sqlite3 连接（与 projects/runs 同一个 nodesign.db）。
 * 建表走仓里的既有范式：import 副作用式幂等 DDL。密码存储格式 scrypt$<N>$<saltHex>$<hashHex>
 * （算法在写侧；这里只知道有这么一列）。
 */
import db from '../engine/runs/store.js';
import { PLANS } from './tier.js';
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

// ── 用户 ──

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

/** 开放注册开关（.env NODESIGN_OPEN_REGISTRATION=1）。关着时没邀请码照旧拒 */
export function openRegistrationEnabled() {
  return /^(1|true|yes)$/i.test(String(process.env.NODESIGN_OPEN_REGISTRATION || ''));
}

