/**
 * server/api/chatai.js —— 演出端点：页面 → 服务端 → 中转站。
 *
 * agent 写的演出前端（iframe 里的站点页）打这两条路由；chatai 的 key 在服务端
 * env，页面永远拿不到。页面靠同源 cookie 认证，不发任何新凭证。
 *
 * ⭐ 演出路**不过内容审查**（2026-08-15 拍板）：chatai 无工具、无会话、改不了
 * 任何文件，出格也只是文本；审查只存在于 agent 侧。但不过审 ≠ 不设闸，四道闸
 * 全钉在这一个口上：
 *
 *   1. 通路批准制 —— auth/tier.js localGenApproved：档位有资格（admin/pro）且被站主逐人批过（同 roll_film 那套）；basic 档不开。
 *      中转站计量单位不明，问清之前不对全量内测用户开。
 *   2. 金额闸门 —— checkQuota 同一个 USD 池：每轮花费按我们的单价表记进
 *      runs + run_model_usage（skill_id='chatai'），跟 agent 会话共享日限/终身额度。
 *   3. 频率闸门 —— 滑动窗口每用户每分钟 N 轮（env NODESIGN_CHATAI_TURNS_PER_MIN，
 *      默认 10）。金额日限拦不住单日尖峰，这道闸才是 setInterval 烧钱机的对手。
 *   4. 单演出串行 —— 同一文件夹同时只跑一轮（保护 对话.jsonl 成对追加与摘要
 *      折叠），撞上返 409 而不是排队。
 *
 * 流式默认 SSE（data: {delta} … data: {done, usage, costUsd, 摘要}）；
 * body.stream=false 走整段 JSON。中转站分片本来就粗，别指望逐字。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import { guardProject } from './_guard.js';
import { msg } from '../shared/messages.js';
import { getWorkspaceRoot } from '../projects/workspace.js';
import { performTurn } from '../engine/chatai/perform.js';
import {
  loadOrchestration, normalizeOrchestration, serializeOrchestration,
  resolveInside, estTokens, CONFIG_FILE,
} from '../engine/chatai/orchestrate.js';
import { readLog, readSummary, SUMMARY_FILE } from '../engine/chatai/chat-log.js';
import { modelCatalog } from '../engine/chatai/index.js';
import { checkQuota, fmtUsd } from '../lib/quota.js';
import { can, localGenApproved } from '../auth/tier.js';
import { makeRateWindow } from '../lib/rate-window.js';
import {
  createRun, markRunStarted, markRunSucceeded, markRunFailed,
  setRunMetrics, setRunModelUsage,
} from '../engine/runs/store.js';

const router = express.Router();
export default router;

const MAX_INPUT_CHARS = 8000;

const rate = makeRateWindow({
  limit: Number(process.env.NODESIGN_CHATAI_TURNS_PER_MIN) || 10,
  windowMs: 60_000,
});

/** 正在演出的文件夹（abs path → true）。串行是保护 jsonl，不是并发额度。 */
const playing = new Set();

function gateApproved(req, res) {
  // 档位 + 逐人批准（auth/tier.js localGenApproved）：basic 档不开，pro 档要被站主批过
  if (localGenApproved(req.user)) return true;
  res.status(403).json({ error: msg(req, '演出通路尚未对这个账号开放') });
  return false;
}

/** 解析演出文件夹：相对工作区根，防逃逸，必须真是目录。失败时已发响应。 */
async function resolvePerformanceDir(req, res) {
  const root = path.resolve(getWorkspaceRoot(req.params.pid));
  const rel = String(req.method === 'GET' ? req.query.dir ?? '' : req.body?.dir ?? '');
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    res.status(400).json({ error: 'dir 跑出了项目工作区' });
    return null;
  }
  try {
    if (!(await fs.stat(abs)).isDirectory()) throw new Error();
  } catch {
    res.status(404).json({ error: '演出文件夹不存在' });
    return null;
  }
  return { abs, rel };
}

function statusOfOrchError(err) {
  if (err?.code === 'ORCH_NO_CONFIG') return 404;
  if (err?.code === 'ORCH_INVALID') return 422;
  if (err?.code === 'CHATAI_UNCONFIGURED') return 503;
  if (err?.code === 'CHATAI_UPSTREAM') return 502;
  return 500;
}

/** 把一轮（正文 + 可能的摘要调用）的用量并成 run_model_usage 行 */
function usageRows(out) {
  const rows = new Map();
  const add = (model, usage, costUsd) => {
    if (!usage) return;
    const key = model || 'unknown';
    const acc = rows.get(key) || {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0,
    };
    // 列口径对齐 agent 行：input 不含缓存读（openai 格式的 prompt_tokens 含，要拆）；
    // 思考 token 按输出计（Gemini 口径，costOf 同款）
    acc.inputTokens += Math.max(0, (usage.inputTokens || 0) - (usage.cacheReadTokens || 0));
    acc.outputTokens += (usage.outputTokens || 0) + (usage.reasoningTokens || 0);
    acc.cacheReadTokens += usage.cacheReadTokens || 0;
    acc.costUsd += costUsd || 0;
    rows.set(key, acc);
  };
  add(out.model, out.usage, out.costUsd);
  if (out.摘要?.用量) add(out.摘要.模型, out.摘要.用量, out.摘要.花费);
  return rows;
}

function meterRun(runId, out) {
  const rows = usageRows(out);
  setRunModelUsage(runId, Object.fromEntries(rows));
  const total = [...rows.values()].reduce((a, r) => ({
    inputTokens: a.inputTokens + r.inputTokens,
    outputTokens: a.outputTokens + r.outputTokens,
    cacheReadTokens: a.cacheReadTokens + r.cacheReadTokens,
    totalCostUsd: a.totalCostUsd + r.costUsd,
  }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalCostUsd: 0 });
  setRunMetrics(runId, total);
  return total.totalCostUsd;
}

/**
 * GET /:pid/chatai/log?dir=…  —— 页面打开时渲染既有对话。
 * 读不花钱不限频；只要项目归属过关就给。
 */
router.get('/:pid/chatai/log', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const dir = await resolvePerformanceDir(req, res);
    if (!dir) return;
    let config;
    try {
      config = await loadOrchestration(dir.abs);
    } catch (err) {
      return res.status(statusOfOrchError(err)).json({ error: err.message });
    }
    const [records, summary] = await Promise.all([
      readLog(dir.abs, config), readSummary(dir.abs),
    ]);
    res.json({
      records,
      摘要: summary ? { 至: summary.至, 内容: summary.内容 } : null,
      配置: { 模型: config.模型, 最大输出: config.最大输出, 上下文预算: config.上下文预算 },
    });
  } catch (err) { next(err); }
});

/**
 * GET /:pid/chatai/config?dir=…  —— 设置页的一次取齐：归一后的配置 +
 * 条目引用的文件内容 + 历史/摘要状况。token 估算前端自己算（同款下限口径）。
 */
router.get('/:pid/chatai/config', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const dir = await resolvePerformanceDir(req, res);
    if (!dir) return;
    let config;
    try {
      config = await loadOrchestration(dir.abs);
    } catch (err) {
      return res.status(statusOfOrchError(err)).json({ error: err.message, code: err.code || null });
    }
    const 文件 = {};
    for (const e of [...config.系统层, ...config.尾部]) {
      if (e.文件 == null || e.文件 in 文件) continue;
      try {
        文件[e.文件] = await fs.readFile(resolveInside(dir.abs, e.文件, `条目「${e.名字}」`), 'utf8');
      } catch { 文件[e.文件] = null; }   // 引用悬空：设置页要红给用户看，不是 500
    }
    const [records, summary] = await Promise.all([readLog(dir.abs, config), readSummary(dir.abs)]);
    const boundary = summary?.至 ?? 0;
    res.json({
      配置: config,
      文件,
      // 模型/单价/思考档由服务端一张表说了算（MODEL_SPECS），前端只负责画——
      // 中转站改名或换档位时不用两头改（单一真相源）。
      模型表: modelCatalog(),
      状况: {
        记录条数: records.length,
        轮数: records.filter(r => r.role === 'user').length,
        活历史tok: records.filter(r => r.seq > boundary).reduce((n, r) => n + estTokens(r.text), 0),
        摘要: summary ? { 至: summary.至, 内容: summary.内容 } : null,
      },
    });
  } catch (err) { next(err); }
});

/**
 * PUT /:pid/chatai/config  body { dir, 配置, 文件? }
 *
 * 校验（normalizeOrchestration，跟演出路同一份）→ 先写引用文件、再原子写
 * 编排.yaml。改动下一轮生效——正在跑的那轮已经编译完了，不追。
 * 文件表只许写文件夹内部，且不许碰 编排.yaml / 摘要.json / 对话记录本体。
 */
router.put('/:pid/chatai/config', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const dir = await resolvePerformanceDir(req, res);
    if (!dir) return;
    let config;
    try {
      config = normalizeOrchestration(req.body?.配置);
    } catch (err) {
      return res.status(422).json({ error: err.message });
    }
    const files = req.body?.文件 && typeof req.body.文件 === 'object' ? req.body.文件 : {};
    const forbidden = new Set([CONFIG_FILE, SUMMARY_FILE, config.历史.文件]);
    for (const [rel, text] of Object.entries(files)) {
      if (forbidden.has(rel)) {
        return res.status(422).json({ error: `「${rel}」不归设置页写（配置/摘要/对话记录各有各的落盘路）` });
      }
      if (typeof text !== 'string') return res.status(422).json({ error: `文件「${rel}」的内容要是字符串` });
      let abs;
      try { abs = resolveInside(dir.abs, rel, '文件表'); } catch (err) {
        return res.status(422).json({ error: err.message });
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, text, 'utf8');
    }
    const target = path.join(dir.abs, CONFIG_FILE);
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, serializeOrchestration(config), 'utf8');
    await fs.rename(tmp, target);
    res.json({ ok: true, 配置: config });
  } catch (err) { next(err); }
});

/**
 * POST /:pid/chatai/turn  body { dir, input, stream? }
 */
router.post('/:pid/chatai/turn', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    if (!gateApproved(req, res)) return;

    const input = String(req.body?.input ?? '').trim();
    if (!input) return res.status(422).json({ error: msg(req, 'input 是空的') });
    if (input.length > MAX_INPUT_CHARS) {
      return res.status(422).json({ error: msg(req, 'input 超长（上限 {max} 字符）', { max: MAX_INPUT_CHARS }) });
    }

    // 08-21 经营态：演出通路烧的是带钥匙的 API 钱，公开注册号（免费档）不开 —— 跟订阅 Claude 同一把资格
    if (!can(req.user, 'subscription')) {
      return res.status(403).json({ error: msg(req, '演出模式仅限 Pro 档，暂未对外开放；当前档位请用设计会话'), code: 'MODEL_LOCKED' });
    }
    const quota = checkQuota(req.user);
    if (!quota.ok) {
      const word = quota.kind === 'lifetime' ? msg(req, '试用额度') : msg(req, '今日额度');
      return res.status(429).json({ error: msg(req, '{word}用完了（{used} / {limit}）', { word, used: fmtUsd(quota.used), limit: fmtUsd(quota.limit) }) });
    }
    const r = rate.take(req.user?.id ?? 'anon');
    if (!r.ok) {
      res.setHeader('Retry-After', Math.ceil(r.retryAfterMs / 1000));
      return res.status(429).json({ error: msg(req, '太快了，歇几秒再发') });
    }

    const dir = await resolvePerformanceDir(req, res);
    if (!dir) return;
    if (playing.has(dir.abs)) {
      return res.status(409).json({ error: msg(req, '这场演出正有一轮在跑，等它回完') });
    }

    const stream = req.body?.stream !== false;
    const run = createRun({
      skillId: 'chatai',
      brief: input.slice(0, 120),
      projectId: req.params.pid,
      userId: req.user?.id ?? null,
      metadata: { dir: dir.rel, kind: 'chatai-turn' },
    });
    markRunStarted(run.id);

    // 客户端断开就掐上游：落盘在调用成功之后，掐掉的轮子不留半条记录
    const ctrl = new AbortController();
    req.on('close', () => { if (!res.writableEnded) ctrl.abort(new Error('客户端断开')); });

    playing.add(dir.abs);
    try {
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();
        const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        try {
          const out = await performTurn({
            dir: dir.abs, userInput: input, signal: ctrl.signal,
            onDelta: (piece) => send({ delta: piece }),
          });
          const costUsd = meterRun(run.id, out);
          markRunSucceeded(run.id);
          send({
            done: true, text: out.text, usage: out.usage, costUsd,
            模型: out.model, 档: out.档 ?? null, ...(out.降级 ? { 降级: out.降级 } : {}),
            摘要: out.摘要 ? { 折叠: !out.摘要.失败, ...(out.摘要.失败 ? { 失败: out.摘要.失败 } : {}) } : null,
          });
        } catch (err) {
          markRunFailed(run.id, err.message);
          send({ error: err.message, code: err.code || null });
        }
        res.end();
      } else {
        try {
          const out = await performTurn({ dir: dir.abs, userInput: input, signal: ctrl.signal });
          const costUsd = meterRun(run.id, out);
          markRunSucceeded(run.id);
          res.json({
            text: out.text, usage: out.usage, costUsd, meta: out.meta,
            模型: out.model, 档: out.档 ?? null, ...(out.降级 ? { 降级: out.降级 } : {}),
            摘要: out.摘要 ? { 折叠: !out.摘要.失败, ...(out.摘要.失败 ? { 失败: out.摘要.失败 } : {}) } : null,
          });
        } catch (err) {
          markRunFailed(run.id, err.message);
          res.status(statusOfOrchError(err)).json({ error: err.message, code: err.code || null });
        }
      }
    } finally {
      playing.delete(dir.abs);
    }
  } catch (err) { next(err); }
});
