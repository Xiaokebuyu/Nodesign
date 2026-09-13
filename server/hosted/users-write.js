/**
 * server/hosted/users-write.js — 用户表的**写侧**（只在多用户站上）：密码、建号、邀请码、注册、启动 bootstrap。
 *
 * 读侧（查用户、改字段、登录墙开关）在内核 auth/users-store.js，这里 import 它，方向只许这一边。
 * 密码：node 内置 crypto.scrypt，存储 scrypt$<N>$<saltHex>$<hashHex>，参数变更时旧记录仍按自记录的 N 校验。
 * 邀请码：admin 生成，限次数/可过期；注册时事务内 used_count+1 防并发超发。
 *
 * bootstrapAuth()（hosted/mount.js 起动时调，幂等）：
 *   - users 空 && NODESIGN_AUTH_PASSWORD 存在 → 用该密码建 admin 账号
 *   - projects.owner_id 为 NULL 的存量行 → 回填 admin（历史项目全归站主）
 */
import crypto from 'node:crypto';
import db from '../engine/runs/store.js';
import { PLANS, basicDefaultDailyUsd } from '../auth/tier.js';
import { getUserById, getUserByUsername, getUserByEmail, normalizeEmail, countUsers, openRegistrationEnabled, invalidateUserCache } from '../auth/users-store.js';

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

/** 仅第三方登录、还没设过密码的号存这个占位值：verifyPassword 的格式校验对它恒失败 */
export const NO_PASSWORD = '!';

/**
 * 登录用：要拿 hash 比对，不走 rowToUser（hash 不出模块）。
 * identifier 含 @ 按邮箱查，否则按用户名查（不区分大小写，09-13 起有唯一索引兜着）。
 */
export function getCredential(identifier) {
  if (typeof identifier !== 'string' || !identifier.trim()) return null;
  const id = identifier.trim();
  const row = id.includes('@')
    ? db.prepare('SELECT id, password_hash, disabled, email FROM users WHERE email = ?').get(normalizeEmail(id) || '')
    : db.prepare('SELECT id, password_hash, disabled, email FROM users WHERE username = ? COLLATE NOCASE').get(id);
  return row ? { id: row.id, passwordHash: row.password_hash, disabled: !!row.disabled, email: row.email || null } : null;
}

export function createUser({ username, password = null, passwordHash = null, email = null, role = 'user', inviteCode = null, lifetimeCostLimitUsd = null, dailyCostLimitUsd = null, plan = 'basic' }) {
  if (!PLANS.includes(plan)) throw new Error(`createUser: plan 需为 ${PLANS.join('/')}，收到 '${plan}'`);
  const id = newUserId();
  const hash = passwordHash || (password ? hashPassword(password) : NO_PASSWORD);
  const mail = email ? normalizeEmail(email) : null;
  if (email && !mail) throw new Error('createUser: 邮箱格式不对');
  db.prepare(`INSERT INTO users (id, username, password_hash, role, invite_code, lifetime_cost_limit_usd, daily_cost_limit_usd, plan, email, email_verified_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, username, hash, role, inviteCode, lifetimeCostLimitUsd, dailyCostLimitUsd, plan, mail, mail ? new Date().toISOString() : null);
  return getUserById(id);
}

/** 设新密码（调用方先过 password-policy） */
export function setPassword(userId, password) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), userId);
  invalidateUserCache(userId);
}

/** 绑定 / 更换邮箱（已验证过的）。被别的号占用时抛 EMAIL_TAKEN */
export function setEmail(userId, email) {
  const mail = normalizeEmail(email);
  if (!mail) throw Object.assign(new Error('邮箱格式不对'), { code: 'BAD_EMAIL' });
  const owner = getUserByEmail(mail);
  if (owner && owner.id !== userId) throw Object.assign(new Error('这个邮箱已经注册过了'), { code: 'EMAIL_TAKEN' });
  db.prepare('UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?').run(mail, new Date().toISOString(), userId);
  invalidateUserCache(userId);
  return getUserById(userId);
}

/** 改用户名（显示名，也仍可用来登录）。撞名抛 USERNAME_TAKEN */
export function setUsername(userId, username) {
  if (!validUsername(username)) throw Object.assign(new Error('用户名 2-32 位，仅限字母数字下划线连字符和中文'), { code: 'BAD_USERNAME' });
  const other = getUserByUsername(username);
  if (other && other.id !== userId) throw Object.assign(new Error('用户名已被使用'), { code: 'USERNAME_TAKEN' });
  db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, userId);
  invalidateUserCache(userId);
  return getUserById(userId);
}

/**
 * 从邮箱前缀 / 第三方昵称派生一个可用的用户名：只留合法字符，不够 2 位补 user，撞名追加数字。
 * 用户注册完可以在账号页改。
 */
export function deriveUsername(seed) {
  let base = String(seed || '').split('@')[0].replace(/[^A-Za-z0-9_一-鿿-]/g, '').slice(0, 24);
  if (base.length < 2) base = `user${base}`;
  if (!getUserByUsername(base)) return base;
  for (let i = 0; i < 20; i += 1) {
    const candidate = `${base}${crypto.randomInt(10, 10_000)}`;
    if (!getUserByUsername(candidate)) return candidate;
  }
  return `user${crypto.randomBytes(4).toString('hex')}`;
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
/**
 * 注册前的邀请码预检（不消耗）：邮箱注册在发验证码之前先判一次，码无效就别让人白等一封信。
 * 真正消耗在 registerWithEmail 的事务里再判一次（中间可能被别人用掉）。
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
export function precheckSignup(inviteCode) {
  const code = String(inviteCode || '').trim();
  if (!code) {
    return openRegistrationEnabled() ? { ok: true } : { ok: false, code: 'BAD_INVITE', message: '邀请码无效' };
  }
  const inv = getInvite(code);
  if (!inv) return { ok: false, code: 'BAD_INVITE', message: '邀请码无效' };
  if (inv.expires_at && new Date(inv.expires_at).getTime() < Date.now()) return { ok: false, code: 'INVITE_EXPIRED', message: '邀请码已过期' };
  if (inv.used_count >= inv.max_uses) return { ok: false, code: 'INVITE_EXHAUSTED', message: '邀请码已用完' };
  return { ok: true };
}

/** 事务内：按邀请码决定档位与额度，带码的顺手消耗 */
function signupTermsInTx(inviteCode) {
  const code = String(inviteCode || '').trim();
  const pre = precheckSignup(code);
  if (!pre.ok) throw Object.assign(new Error(pre.message), { code: pre.code });
  if (!code) return { inviteCode: null, plan: 'basic', dailyCostLimitUsd: basicDefaultDailyUsd(), lifetimeCostLimitUsd: null };
  const inv = getInvite(code);
  db.prepare('UPDATE invites SET used_count = used_count + 1 WHERE code = ?').run(inv.code);
  return { inviteCode: inv.code, plan: 'pro', dailyCostLimitUsd: defaultInviteDailyUsd(), lifetimeCostLimitUsd: inv.grant_lifetime_usd ?? null };
}

/**
 * 邮箱注册（09-13 auth-v2）：验证码核验通过之后调。密码在发码时就已经哈希好存进验证码的 payload，
 * 这里直接落哈希；用户名从邮箱前缀派生，注册完可改。
 */
export const registerWithEmail = db.transaction(({ email, passwordHash, inviteCode = '', username = null }) => {
  const mail = normalizeEmail(email);
  if (!mail) throw Object.assign(new Error('邮箱格式不对'), { code: 'BAD_EMAIL' });
  if (getUserByEmail(mail)) throw Object.assign(new Error('这个邮箱已经注册过了'), { code: 'EMAIL_TAKEN' });
  const terms = signupTermsInTx(inviteCode);
  const name = username && validUsername(username) && !getUserByUsername(username) ? username : deriveUsername(mail);
  return createUser({ username: name, passwordHash, email: mail, role: 'user', ...terms });
});

/**
 * 第三方登录首次进来建号（09-13 auth-v2 第二批）：不带邀请码，走开放注册（关着就拒），落 basic 档，没有密码。
 * email 只在服务商确认过（verified）时才传进来，记为已验证。
 */
export const registerViaOAuth = db.transaction(({ email, usernameSeed }) => {
  const terms = signupTermsInTx('');
  const mail = email ? normalizeEmail(email) : null;
  if (!mail) throw Object.assign(new Error('邮箱格式不对'), { code: 'BAD_EMAIL' });   // 第三方号没有密码，没邮箱就找不回来
  if (getUserByEmail(mail)) throw Object.assign(new Error('这个邮箱已经注册过了'), { code: 'EMAIL_TAKEN' });
  return createUser({ username: deriveUsername(usernameSeed || mail), email: mail, role: 'user', ...terms });
});

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
  return admin ? getUserById(admin.id) : null;
}
