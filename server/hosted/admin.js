/**
 * server/api/admin.js — 内测管理接口（2026-07-30）
 *
 * 全部挂 adminGuard（authGuard 已在外层挂好 req.user）。用户/邀请码还是走
 * curl / server/scripts/invite.mjs；问题库有页面（/admin/issues）。
 *
 *   POST   /api/admin/invites          {maxUses?, expiresInDays?} → 生成邀请码
 *   GET    /api/admin/invites          邀请码列表（含用量）
 *   PATCH  /api/admin/invites/:code    {maxUses} 改总次数（0 = 封死）
 *   GET    /api/admin/users            用户列表 + 今日用量
 *   GET    /api/admin/modes            设计 / 演出 两个模式各自的用量（不含站主）
 *   PATCH  /api/admin/users/:id        {disabled?, dailyCostLimitUsd?, lifetimeCostLimitUsd?} 封禁/调限额
 *   GET    /api/admin/issues           harness 问题库（按次数降序）+ 按工具聚合
 *   PATCH  /api/admin/issues/:id       {status} open|ack|ignored|closed
 *   DELETE /api/admin/issues/:id       删掉一条
 */

import express from 'express';
import { createInvite, listInvites, getInvite, updateInvite } from './users-write.js';
import { getUserById, listUsers, updateUser } from '../auth/users-store.js';
import { modeStats } from '../projects/store.js';
import { tierOf, PLANS } from '../auth/tier.js';
import { usedCostToday, usedCostTotal, usedTokensToday, limitFor } from '../lib/quota.js';
import { listIssues, setIssueStatus, removeIssue, issueStats } from '../lib/issues-store.js';
import { createNotice, listNotices, getActiveNotice, retireNotice, retireAllNotices } from '../lib/notice-store.js';
import { flagCounts, listFlags, removeFlag, levelForKnob, LEVELS } from '../lib/moderation.js';

const router = express.Router();
// admin 专属守卫。原来住在 auth/middleware.js，那是内核文件；这里是它唯一的使用者，
// 跟着搬过来 hosted/ 之后，内核就不必为一个只有管理台用的判决保留代码。
function adminGuard(req, res, next) {
  if (req.user?.role === 'admin') return next();
  res.status(403).json({ error: 'admin only', code: 'FORBIDDEN' });
}

router.use(adminGuard);

router.post('/invites', (req, res) => {
  const maxUses = Number(req.body?.maxUses) || 1;
  const days = Number(req.body?.expiresInDays);
  const expiresAt = Number.isFinite(days) && days > 0
    ? new Date(Date.now() + days * 86400_000).toISOString() : null;
  // grantLifetimeUsd：该码注册的号走终身额度（试用口径，不刷新）
  const grant = Number(req.body?.grantLifetimeUsd);
  const invite = createInvite({
    createdBy: req.user.id,
    maxUses: Math.max(1, Math.min(100, maxUses)),
    expiresAt,
    grantLifetimeUsd: Number.isFinite(grant) && grant > 0 ? grant : null,
  });
  res.status(201).json({ invite });
});

router.get('/invites', (_req, res) => {
  res.json({ invites: listInvites() });
});

// 改可用次数（总次数口径）。0 或 ≤ 已用数 = 封死该码 —— 泄漏时的止血阀，
// 所以这里不设下限 1，也不 clamp 到 100（长期公开码就是要给大数的）
router.patch('/invites/:code', (req, res) => {
  if (!getInvite(req.params.code)) return res.status(404).json({ error: 'invite not found' });
  const maxUses = Number(req.body?.maxUses);
  if (!Number.isInteger(maxUses) || maxUses < 0 || maxUses > 100000) {
    return res.status(400).json({ error: 'maxUses 需为 0-100000 的整数（0 = 封死）' });
  }
  res.json({ invite: updateInvite(req.params.code, { maxUses }) });
});

router.get('/users', (_req, res) => {
  const flags = flagCounts();                 // 内容外审标记（lib/moderation.js）
  const users = listUsers().map(u => ({
    ...u,
    tier: tierOf(u),                          // admin | pro | basic（auth/tier.js 派生；前端章只认这个）
    costToday: usedCostToday(u.id),           // 美元，闸门真口径
    costTotal: usedCostTotal(u.id),           // 全史；试用号（lifetimeCostLimitUsd 非空）拿它对限额
    tokensToday: usedTokensToday(u.id),       // 参考
    effectiveDailyLimitUsd: limitFor(u),
    flagsCount: flags.get(u.id) || 0,
    effectiveModerationLevel: levelForKnob(u, 'subscription'),  // 订阅模型：默认档算完的实际生效值
    effectiveModerationLevelApi: levelForKnob(u, 'api'),         // 本地/中转旋钮的生效值
  }));
  res.json({ users });
});

// 两个模式各自的用量。只读、无参数，控制台顶上那两张卡用。
router.get('/modes', (_req, res) => {
  res.json({ modes: modeStats() });
});

router.patch('/users/:id', (req, res) => {
  const user = getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'user not found' });
  const patch = {};
  if (typeof req.body?.disabled === 'boolean') patch.disabled = req.body.disabled;
  // 外审强度：null = 跟随默认档（按档位：basic strict / pro loose / admin off，auth/tier.js）
  // 两个旋钮（08-20）：订阅模型 / 本地与中转（见 lib/moderation.js 文件头）
  for (const key of ['moderationLevel', 'moderationLevelApi']) {
    if (!(key in (req.body || {}))) continue;
    const lv = req.body[key];
    if (lv !== null && !LEVELS.includes(lv)) {
      return res.status(400).json({ error: `${key} 需为 ${LEVELS.join('/')} 或 null` });
    }
    patch[key] = lv;
  }
  if ('localGen' in (req.body || {})) {
    patch.localGen = !!req.body.localGen;
  }
  if ('plan' in (req.body || {})) {
    // 08-21 晚：档位真相源（auth/tier.js）。订阅/生图/发布/外审默认档全从它派生；admin 的 plan 不可改（role 派生）
    if (user.role === 'admin') return res.status(400).json({ error: 'admin 的档位由 role 派生，不可改' });
    if (!PLANS.includes(req.body.plan)) return res.status(400).json({ error: `plan 需为 ${PLANS.join('/')}` });
    patch.plan = req.body.plan;
  }
  // 07-31 起限额单位是美元。老字段 dailyTokenLimit 仍收（存量数据能改回去），
  // 但它已经不参与闸门判断了 —— 真正生效的是 dailyCostLimitUsd。
  for (const [key, label] of [['dailyCostLimitUsd', '美元'], ['lifetimeCostLimitUsd', '美元'], ['dailyTokenLimit', 'token']]) {
    if (!(key in (req.body || {}))) continue;
    const v = req.body[key];
    if (v !== null && (!Number.isFinite(Number(v)) || Number(v) < 0)) {
      return res.status(400).json({ error: `${key} 需为非负数（${label}）或 null` });
    }
    patch[key] = v === null ? null : Number(v);
  }
  res.json({ user: updateUser(user.id, patch) });
});

// ── 站内公告（2026-07-31）──
// 一次只有一条生效（取最新）。发新的等于覆盖旧的，不用先下架。

router.get('/notices', (_req, res) => {
  res.json({ notices: listNotices(), active: getActiveNotice() });
});

router.post('/notices', (req, res) => {
  try {
    const notice = createNotice({
      body: req.body?.body,
      level: req.body?.level || 'info',
      expiresInHours: req.body?.expiresInHours,
    });
    res.status(201).json({ notice });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/notices/:id', (req, res) => {
  if (req.params.id === 'all') return res.json({ retired: retireAllNotices() });
  if (!retireNotice(req.params.id)) return res.status(404).json({ error: 'notice not found' });
  res.status(204).end();
});

// ── 内容外审留证（2026-08-02）──
// 拦截发生在 turn.js 闸门；这里只读账。连坐封禁自动发生（lib/moderation.js），
// 解封走既有 PATCH /users/:id {disabled:false}。

router.get('/moderation', (req, res) => {
  const userId = typeof req.query.userId === 'string' && req.query.userId ? req.query.userId : null;
  const limit = Math.min(500, Number(req.query.limit) || 100);
  res.json({ flags: listFlags({ userId, limit }) });
});

router.delete('/moderation/:id', (req, res) => {
  if (!removeFlag(req.params.id)) return res.status(404).json({ error: 'flag not found' });
  res.status(204).end();
});

// ── harness 问题库（2026-07-30）──
// 两个来源写同一张表：auto = PostToolUseFailure 自动记的工具失败；
// agent = report_friction 主动报的摩擦。默认按次数降序 —— 一眼看到最该修的。

router.get('/issues', (req, res) => {
  const { status, source, kind } = req.query;
  const limit = Math.min(500, Number(req.query.limit) || 200);
  res.json({
    issues: listIssues({
      status: typeof status === 'string' && status !== 'all' ? status : undefined,
      source: typeof source === 'string' && source !== 'all' ? source : undefined,
      kind: typeof kind === 'string' && kind !== 'all' ? kind : undefined,
      limit,
    }),
    stats: issueStats(),
  });
});

router.patch('/issues/:id', (req, res) => {
  try {
    const issue = setIssueStatus(req.params.id, String(req.body?.status || ''));
    if (!issue) return res.status(404).json({ error: 'issue not found' });
    res.json({ issue });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/issues/:id', (req, res) => {
  if (!removeIssue(req.params.id)) return res.status(404).json({ error: 'issue not found' });
  res.status(204).end();
});

export default router;
