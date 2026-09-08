/**
 * server/api/me.js — 当前用户自视图（2026-07-30 内测）
 *
 *   GET    /api/me/usage              → { usedToday, limit, username, role }
 *   GET    /api/me/models             → { options } 这个账号能选的模型（没有会话时问这条）
 *   GET    /api/me/showcase           → 个人作品橱窗（作品 + 它沉淀出来的 skill）
 *   GET    /api/me/showcase/:id/cover → 该作品封面 webp（复用首页那套截图缓存）
 *   DELETE /api/me/showcase/:id       → 移出橱窗（只删卡片，不动作品本体）
 *
 * 橱窗条目目前由 agent 的 crystallize_skill 工具产生；跨用户的"市场"还没开
 * （别人的 SKILL.md 会整段进你的 agent 上下文，得先有审核范围）。
 */

import express from 'express';
import { checkQuota, usedTodayByFamily, usedTokensToday, familyLabel, dailyCostSeries } from '../lib/quota.js';
import { platform } from '../runtime/platform.js';
import { relayConfig, relayUsageDaily } from '../runtime/relay-client.js';
import { getActiveNotice } from '../lib/notice-store.js';
import { listEntries, getEntry, removeEntry } from '../lib/showcase-store.js';
import { getArtifactCover } from '../lib/cover.js';
import { getSharedDir } from '../projects/workspace.js';
import { getProject } from '../projects/store.js';
import { selectableModelsFor, defaultModelFor, modelSourceFor, upstreamOf } from '../engine/agent/model-context.js';
import { noteOf } from '../engine/agent/model-notes.js';
import { upstreamHealth } from '../lib/ingress/upstream-health.js';
import { tierOf } from '../auth/tier.js';
import { getAvatar, setAvatar, clearAvatar, avatarAt, AVATAR_MAX_UPLOAD } from '../lib/avatar-store.js';
import { recordIssue, signatureOf } from '../lib/issues-store.js';

const router = express.Router();

/**
 * 这个账号能选的模型清单 —— **没有会话时**（首页快速开始 / 项目 Hub）走这条。
 *
 * 有会话的那条在 `GET /:pid/sessions/:sid/model`，它顺带回当前生效值；这里没有
 * 可读的会话配置，所以只回清单，选中值仍由前端的本地偏好决定。
 *
 * 为什么要有这条：前端原来在没有会话时直接吃 `web/src/lib/models.js` 的
 * `FALLBACK_MODELS` 硬编码常量，于是**带闸门的模型（本地 Qwen）在首页永远不出现** ——
 * 会话里能选、首页选不了，同一颗按钮两种清单。兜底清单从此只在这条接口也挂了时用。
 */
/**
 * 给每行挂上「状态色点」和「印象短语」—— 输入框上方那排贴纸的数据源（09-08）。
 *
 * · `health.state`  机器算的（`ingress/upstream-health.js` 的环形账）：ok / degraded / down / nodata
 * · `note`          人写的（`engine/agent/model-notes.js`），没写就没有，界面留白
 *
 * ⛔ **半小时没请求一律 nodata**，不拿旧数据装绿 —— 判据在账本那边，这里只是转发。
 * ⚠️ 色点是**上游**的健康度不是厂商的：几行共用一条上游会一起亮灭，而 merge 那条线上
 *    究竟是谁在服务只有 `x-merge-vendor` 知道（见 upstream-health.js 头注）。
 */
function withHealth(options) {
  return options.map((m) => {
    const up = upstreamOf(m.id);
    const h = up ? upstreamHealth.stateOf(up) : null;
    const note = noteOf(m.id);
    return {
      ...m,
      ...(note ? { note } : {}),
      // 没有 api.upstream 的行（订阅线的 claude-*）**不由这本账衡量**，不发 health —— 发「无数据」会把人推去换线（09-08 评审）
      ...(h ? { health: { state: h.state, samples: h.samples, lastAt: h.lastAt, lastReason: h.lastReason, medianMs: h.medianMs } } : {}),
    };
  });
}

router.get('/models', (req, res) => {
  res.json({ options: withHealth(selectableModelsFor(req.user)), default: defaultModelFor(req.user) });
});

/**
 * 近 N 天每日每模型的花费（设置页「用量」曲线）。两个来源分开报，前端叠着画：
 *   local  这台机器自己库里的账（hosted = 站点上跑的回合；本地版 = 本机 BYOK 的回合，走 relay 的回合
 *          本地也会按 SDK 估价记一笔，但那不是真账，按模型来源剔掉）
 *   site   本地版登录了站点账号时，站点账本里这个账号的账（真账，额度按它判）
 */
router.get('/usage/daily', async (req, res) => {
  const days = Math.max(1, Math.min(366, Number(req.query.days) || 30));
  let local = dailyCostSeries(req.user.id, days);
  let site = null;
  if (platform.isLocal) {
    local = local.filter((r) => modelSourceFor(r.model) !== 'relay');
    if (relayConfig()) {
      try { site = (await relayUsageDaily(days)).series; }
      catch (err) { site = { error: err.message }; }
    }
  }
  res.json({ days, local, site });
});

/**
 * 今日用量。**单位是美元**（口径见 lib/quota.js 文件头）。
 *
 * 金额对所有人可见（07-31 定案）。先前藏过一版，顾虑是"$1.36 / $15.00"会被读成
 * 账单；但换模型的冷启动提醒必须带一个数才有意义，而同一个东西在一个地方说
 * 美元、另一个地方说百分比，用户没法把两句话对上。统一成钱，顺带让人知道
 * 这些对话背后有真实成本 —— 这本身就是内测该传达的信息。
 */
router.get('/usage', (req, res) => {
  const { usedToday, limit, kind, used } = checkQuota(req.user);
  const byFamily = usedTodayByFamily(req.user.id);
  // 分模型只报明细不报限额 —— 07-31 起限额是一个总数，模型之间不再分账
  const models = Object.entries(byFamily)
    .filter(([, v]) => v.costUsd > 0 || v.tokens > 0)
    .sort((a, b) => b[1].costUsd - a[1].costUsd)
    .map(([family, v]) => ({
      family,
      label: familyLabel(family),
      costUsd: v.costUsd,
      tokens: v.tokens,
    }));
  res.json({
    unit: 'usd',
    kind,                                    // 'unlimited' | 'daily' | 'lifetime'（试用号）
    used,                                    // 与 limit 同口径：daily=今天，lifetime=全史
    usedToday,
    limit,                                   // admin 是 null（不限额）
    pct: limit ? Math.min(100, (used / limit) * 100) : 0,
    capped: limit !== null,
    tokensToday: usedTokensToday(req.user.id),
    models,
    // 站内公告搭这趟车（2026-07-31）：横幅组件本来就在 60s 轮询这个端点，
    // 单开一个 /notice 就是第二个轮询循环，为一条一天用不到一次的消息不值得。
    notice: getActiveNotice(),
    username: req.user.username,
    role: req.user.role,
    tier: tierOf(req.user),                  // admin | pro | basic（auth/tier.js）：顶栏朱砂点 / pro 标签 / basic 解锁提示用
    avatarAt: platform.isLocal ? null : avatarAt(req.user.id),   // 头像版本戳：前端拿它给 /api/me/avatar 做缓存穿透
  });
});

// ── 头像（09-07）：GET 出图 / PUT 原图（image/*，≤2MB，服务端缩成 128 webp）/ DELETE 清掉。本地版没有站点账号，走 /api/local/relay/avatar
router.get('/avatar', (req, res) => {
  const a = platform.isLocal ? null : getAvatar(req.user.id);
  if (!a) return res.status(204).end();
  res.set('Content-Type', 'image/webp').set('Cache-Control', 'private, max-age=0, must-revalidate').send(a.buf);
});
router.put('/avatar', express.raw({ type: 'image/*', limit: AVATAR_MAX_UPLOAD }), async (req, res) => {
  if (platform.isLocal) return res.status(404).json({ error: '本地版的头像经站点账号设置' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: '请以 image/* 上传图片文件' });
  try { await setAvatar(req.user.id, req.body); res.json({ ok: true, avatarAt: avatarAt(req.user.id) }); }
  catch (err) { res.status(400).json({ error: `图片无法处理：${err.message}` }); }
});
router.delete('/avatar', (req, res) => {
  if (!platform.isLocal) clearAvatar(req.user.id);
  res.json({ ok: true });
});

router.get('/showcase', (req, res) => {
  const entries = listEntries(req.user.id).map((e) => ({
    ...e,
    // 项目可能已经被删：卡片还在，但别给一个点进去 404 的链接
    projectAlive: e.projectId ? !!getProject(e.projectId) : false,
  }));
  res.json({ entries });
});

router.get('/showcase/:id/cover', async (req, res, next) => {
  try {
    const entry = getEntry(req.params.id);
    if (!entry || entry.userId !== req.user.id) return res.status(404).end();
    if (!entry.projectId || !entry.artifactRel) return res.status(204).end();
    if (!getProject(entry.projectId)) return res.status(204).end();
    let result;
    try {
      result = await getArtifactCover(entry.projectId, getSharedDir(entry.projectId), entry.artifactRel);
    } catch (err) {
      console.warn('[showcase cover] render failed:', err.message);
      return res.status(204).end();
    }
    if (!result) return res.status(204).end();
    if (req.headers['if-none-match'] === `"${result.etag}"`) return res.status(304).end();
    res.set('ETag', `"${result.etag}"`);
    res.set('Cache-Control', 'private, max-age=60');
    res.type('image/webp').send(result.buffer);
  } catch (err) { next(err); }
});

router.delete('/showcase/:id', (req, res) => {
  const removed = removeEntry(req.params.id, req.user.id);
  if (!removed) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

export default router;

// ── 前端错误上报（09-08 诊断埋点⑦）：window.onerror / unhandledrejection 经这里进问题库，source='client' ──
// 每用户每天 20 条；正文里带路由、最近的用户动作面包屑、长任务计数（web/src/lib/client-errors.js 组的）。
const clientIssueCount = new Map();   // `${userId}:${day}` → n
router.post('/client-issues', express.json({ limit: '16kb' }), (req, res) => {
  const b = req.body || {};
  const summary = typeof b.summary === 'string' ? b.summary.trim().slice(0, 200) : '';
  if (summary.length < 8) return res.status(400).json({ error: 'summary 太短' });
  const key = `${req.user.id}:${new Date().toISOString().slice(0, 10)}`;
  const n = (clientIssueCount.get(key) || 0) + 1;
  clientIssueCount.set(key, n);
  if (clientIssueCount.size > 5000) clientIssueCount.clear();
  if (n > 20) return res.status(429).json({ error: '今日前端上报已满' });
  const detail = typeof b.detail === 'string' ? b.detail.slice(0, 6000) : '';
  const rec = recordIssue({
    source: 'client', kind: 'bug', toolName: typeof b.where === 'string' ? `web:${b.where.slice(0, 40)}` : 'web',
    summary, detail, signature: b.signature ? String(b.signature).slice(0, 64) : signatureOf(`client|${summary}`),
    projectId: typeof b.projectId === 'string' ? b.projectId.slice(0, 40) : null, sessionId: null, runId: null, userId: req.user.id,
  });
  res.status(201).json({ ok: true, id: rec?.id ?? null });
});
