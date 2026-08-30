/**
 * server/api/turn.js — 唯一 LLM 入口（agentic 设计的核心）
 *
 * POST /api/projects/:pid/turn
 *   body: {
 *     chat:        string,           // 用户文本
 *     attachments: [{ path, ... }],  // 附件托盘里的内容（asset / anchor / comment）
 *     skillId?:    string,           // 默认走 project.skillId
 *   }
 *   return 202 { runId, sessionId }
 *
 * 行为（streamInput 重构后）：
 *   1. 校验 project + 解析 input
 *   2. composeUserMessage：拼成 SDK content blocks（多模态 / system 提示注入）
 *   3. createRun（pending） — per-turn record，前端按 runId 跟踪
 *   4. 立即返回 runId + sessionId（agent 异步在后端跑）
 *   5. 看 hasActiveQuerySession(sid)：
 *      - 已有 → pushUserMessage 进 inputQueue，runSession 拉走处理（追加 / 续 chat）
 *      - 没有 → startNewRunSession 起新 long-running query handle，预 push 首条 message
 *   6. setActiveSession：写 project.activeSessionId 让下次不带 sid 的 turn fallback
 *
 * 续 turn 不依赖 jsonl resume —— streamInput 模式 query 横跨整个 session，
 * conversation state 在 SDK binary 内存里。
 *
 * 错误：
 *   - runSession throw → 已通过 EventBus 推 run.error；console 留痕
 *   - HTTP 已经 202 返回，不再回 5xx
 */

import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { validateProjectId, getProject, setActiveSession } from '../projects/store.js';
import { guardProject, guardRunInProject, modelUserFor } from './_guard.js';
import {
  ensureProjectWorkspace,
  ensureSessionWorkspace,
  validateSessionId,
  getSessionMetaDir,
} from '../projects/workspace.js';
import { createRun } from '../engine/runs/store.js';
import { runSession } from '../engine/agent/session-loop.js';
import {
  cancelRun, provideAnswer, getQuery, provideElicitation, hasActiveQuerySession, getQuerySession, closeQuerySession, setSessionPermissionMode,
} from '../engine/runs/active-runs.js';
import { pushUserMessage, getQueueDepth } from '../engine/runs/turn-relay.js';
import { applySessionModel, resolveSessionModel } from '../engine/agent/session-model.js';
import { lruGet, lruPut, inflightTurns, INFLIGHT_RETENTION_MS } from './turn-inflight.js';
import { allowedModelsFor, isModelLockedFor, defaultModelFor, modelIsFree, hasSubscriptionAccess, modelSwitchRejection, resolveModelRoute } from '../engine/agent/model-context.js';
import { AsyncQueue } from '../lib/async-queue.js';
import { checkQuota, checkFreeQuota, checkConcurrency, fmtUsd } from '../lib/quota.js';
import { shouldModerate, moderateText, recordViolation, levelFor } from '../lib/moderation.js';
import { getProjectBus } from '../ws/broker.js';
import { Events } from '../engine/agent/events.js';
import { readPendingSummary } from './pending-changes.js';
import { pendingRewinds } from './sessions-rewind.js';
import { platform } from '../runtime/platform.js';
import { composeUserMessage } from './turn-compose.js';

const router = express.Router();

/**
 * SDK uuid 形态。用户消息的 id 在三处必须是**同一个** 36-char uuid：jsonl 里那条
 * user 记录的 uuid、rewindFiles(userMessageId) 的入参、fork 的 upToMessageId。
 * 前端同一份判据在 web/src/components/chat/Message.jsx（改一处记得对另一处）。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Emit run.permission_mode_changed —— 广播 SDK 实际 permissionMode 的变化。唯一的
 * 切换路径（turn 入口 mode 校正）调完 setPermissionMode 后 emit 一次。
 *
 * 前端不镜像这个事件（plan mode 2026-08-21 整体移除后它只剩观测价值）。事件保留给
 * 多 tab 观测和排障用 —— mode 是 SDK 真相的一部分，不该只活在服务端日志里。
 *
 * @param {string} pid
 * @param {string} sid
 * @param {string} mode  - 'default' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'auto'
 */
export function emitPermissionModeChanged(pid, sid, mode) {
  if (!pid || !sid || !mode) return;
  try {
    getProjectBus(pid).publish({
      type: 'run.permission_mode_changed',
      sessionId: sid,
      mode,
      ts: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(`[turn] emitPermissionModeChanged failed: ${err.message}`);
  }
}

router.post('/:pid/turn', async (req, res, next) => {
  // ⚠️ 必须在 try **外面**：catch 是 try 的**兄弟**作用域。写在里面的话 catch 那句
  // `typeof inflightReject === 'function'` 够不到它，而 typeof 对未声明的名字不抛错
  // 只返 'undefined' —— 那条 race 修复就此一声不响地失效（08-17 被 no-undef.lint 扫出）。
  let inflightResolve = null;
  let inflightReject = null;
  try {
    const project = guardProject(req, res);
    if (!project) return;

    const { chat, attachments, skillId, sessionId, permissionMode, requestId, raw, userMessageUuid } = req.body || {};
    // 只发附件不打字也是一条完整消息（2026-08-17，issue #1 第 8 条）：拖张参考图
    // 进来就该能发，逼用户补一句"看看这个"是白要的动作。
    // 空文字 **且** 空附件才是空消息 —— 那个仍然拦。
    const chatText = typeof chat === 'string' ? chat : '';
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    if (!chatText.trim() && !hasAttachments) {
      return res.status(400).json({ error: 'chat string required' });
    }

    // Phase A.6：requestId 命中 LRU → 直接返已存在的 run/session（弱网重发幂等）
    // race 修复：① LRU 命中（已完成请求）→ 立即返；② in-flight 命中（正在跑）→
    // await 第一 POST 的 result 后返 deduped；③ 都 miss → 注册 in-flight Promise
    // 后继续走 createRun 路径，结尾 resolve / reject 通知后续等待者。
    if (typeof requestId === 'string' && requestId) {
      const cached = lruGet(requestId);
      if (cached && cached.pid === project.id) {
        return res.status(202).json({ runId: cached.runId, sessionId: cached.sessionId, userMessageId: cached.userMessageId, deduped: true });
      }
      const inflight = inflightTurns.get(requestId);
      if (inflight) {
        try {
          const r = await inflight;
          if (r && r.pid === project.id) {
            return res.status(202).json({ runId: r.runId, sessionId: r.sessionId, userMessageId: r.userMessageId, deduped: true });
          }
        } catch { /* first POST failed → fall through 让本 POST 重新跑 */ }
      }
      // 注册 in-flight Promise，后到的同 requestId POST 会 await 这个
      const p = new Promise((rs, rj) => { inflightResolve = rs; inflightReject = rj; });
      inflightTurns.set(requestId, p);
      // 防 promise unhandled rejection 警告：失败时也 attach catch
      p.catch(() => {});
    }
    // permissionMode 请求字段保留兼容老前端，但不再参与决定（plan mode 08-21 整体移除）：
    // 启动 mode 一律 platform 默认（生产 bypassPermissions / exp auto）。
    const initialPermissionMode = platform.permissionModeDefault;

    const finalSkillId = (typeof skillId === 'string' && skillId) || project.skillId;

    // C4：先确定 sessionRoot，给 composeUserMessage 看 pending-changes buffer
    // （sid 解析逻辑下面已写）—— 提早 ensure 一次让 buffer 检查能命中真路径。

    // session id 解析逻辑（streamInput 模式）：
    //   - body.sessionId === string → 用该 sid（已有活 query 就 push，没有就起新 runSession）
    //   - body.sessionId === null → 新建 session（前端"+新会话"显式触发）
    //   - body.sessionId 不传 → fallback project.activeSessionId（向后兼容）
    //
    // 新建场景用 randomUUID 预生成 sid，传给 SDK options.sessionId 让 SDK 用
    // 我们的 sid（d.ts:1537 sessionId 单独可传）。cwd 提前切到 sessions/<sid>/，
    // agent 一启动就在 session 沙盒里跑。
    //
    // 变量名仍叫 resumeSessionId 是历史遗留——streamInput 模式不真"resume jsonl"，
    // 它只是"当前要用的 sid"。未 rename 是因为有大量 callsite 兼容成本。
    let resumeSessionId;
    if ('sessionId' in (req.body || {})) {
      resumeSessionId = sessionId || null;
    } else {
      resumeSessionId = project.activeSessionId;
    }
    const isNewSession = !resumeSessionId;
    const sid = isNewSession ? randomUUID() : resumeSessionId;
    validateSessionId(sid);

    // 守卫：临时 rewind query 在跑时拒绝同 sid 新 turn —— 防止两个 SDK subprocess
    // 同时写同一 jsonl。临时 query ~3-5s，用户重试一次就 OK。
    if (pendingRewinds.has(sid)) {
      return res.status(409).json({ error: 'rewind in progress, retry shortly', code: 'REWIND_BUSY' });
    }

    // ── 内测闸门（2026-07-30）：必须在 202 之前同步判 ──
    // 日配额：所有 turn 都扣（排队的稍后也烧钱）。口径是金额不是 token，
    // 原因见 lib/quota.js 文件头 —— 简言之 token 数对缓存命中与否几乎无差别，
    // 金额能差十倍，拿 token 当闸门等于没量到主项。
    //
    // 07-31 起只剩这一道：分模型限额撤了，因为金额天然让 opus 烧得更快，
    // 不需要第二个数字表达同一个意图。
    // 模型解析提前到配额之前（08-21，配额按是否免费分岔）：body.model > 会话覆盖 > 默认（defaultModelFor）
    const requestedModelEarly = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : null;
    const sessionModelEarly = await resolveSessionModel(getSessionMetaDir(project.id, sid));
    const modelUser = modelUserFor(req, project);   // 资格按项目 owner 算（_guard.js）：admin 代看 basic 项目时老会话不许落回订阅行，否则 202 后 INIT_FAILED
    // 老用户没覆盖的老会话保持全局默认，不静默切 Ox；新会话/公开号 → defaultModelFor
    const keepLegacyDefault = !isNewSession && !sessionModelEarly.override && hasSubscriptionAccess(modelUser);
    const turnModel = requestedModelEarly || sessionModelEarly.override
      || (keepLegacyDefault ? sessionModelEarly.model : defaultModelFor(modelUser)) || sessionModelEarly.model;
    // 解析出来的模型一律过白名单（不只 body.model）：旧覆盖/资格收回/无 select 裸名都在此拦（fable P0）
    if (isModelLockedFor(modelUser, turnModel)) {
      return res.status(403).json({
        error: msg(req, '这个模型（{model}）仅限 Pro 档，暂未对外开放。换成免费模型继续', { model: turnModel }),
        code: 'MODEL_LOCKED', model: turnModel,
      });
    }
    if (!allowedModelsFor(modelUser).some((m) => m.id === turnModel)) {   // 清单整个为空（本地版没 key/没登录/没插槽）→ 指路设置页，别让人去选择器里找
      return res.status(403).json(allowedModelsFor(modelUser).length ? { error: msg(req, '这个会话指向的模型（{model}）现在不可用，请在模型选择器里换一个', { model: turnModel }), code: 'MODEL_NOT_ALLOWED', model: turnModel } : { error: msg(req, '还没有可用的模型：到「设置」填 API Key（或本机 claude login），或者配一个模型插槽'), code: 'NO_MODEL_CONFIGURED', model: turnModel });
    }
    // ⛔ 08-25 修：原来这条带着 `sessionModelEarly.override &&`，于是**跑在全局默认上的会话（override=null）
    // 整个逃过检查** —— 而站上默认恰恰是免费的 Ox（openai-chat），正是这条闸要防的那一头。
    // 改成拿**当前有效模型**（override → env → 兜底，resolveSessionModel 已经算好）去比；新会话不拦，
    // 它还没有历史，而这条闸防的是历史里没有 signature 的 thinking 块被回传给真 Anthropic。
    // ⚠️ 已知的一处宽严不匹配：这里的"新会话"判据是 `!resumeSessionId`，而不是 sessions.js 那条 PUT 用的
    // "jsonl 存不存在"。差别只在一种情况——**会话建了但一次没跑过、第一轮就显式换到另一通路**，
    // 这里会多拦一次（409 说"新开一个会话"，人照做就没事）。sessionRoot 要到本函数后半段才拿得到，
    // 为这一种情况把 ensureSessionWorkspace 提前不划算。
    const laneWhy = modelSwitchRejection({ from: sessionModelEarly.model, to: requestedModelEarly, hasHistory: !isNewSession });
    if (laneWhy) return res.status(409).json({ error: laneWhy, code: 'LANE_SWITCH' });
    if (modelIsFree(turnModel)) {
      const fq = checkFreeQuota(req.user);
      if (!fq.ok) {
        return res.status(429).json({ error: msg(req, '今天的免费轮次用完了（{used} / {limit}），明天零点刷新', { used: fq.used, limit: fq.limit }), code: 'QUOTA_EXCEEDED', kind: fq.kind, used: fq.used, limit: fq.limit });
      }
    }
    const quota = modelIsFree(turnModel) ? { ok: true } : checkQuota(req.user);
    if (!quota.ok) {
      return res.status(429).json({
        // 试用号（终身口径）没有"明天刷新"可许诺，文案不能骗人
        error: quota.kind === 'lifetime'
          ? `试用额度已用完（${fmtUsd(quota.used)} / ${fmtUsd(quota.limit)}），感谢体验！想继续用可以联系站主`
          : `今日额度已用完（${fmtUsd(quota.usedToday)} / ${fmtUsd(quota.limit)}），明天零点刷新`,
        code: 'QUOTA_EXCEEDED',
        kind: quota.kind,
        used: quota.used,
        usedToday: quota.usedToday,
        limit: quota.limit,
      });
    }
    // 并发：只拦"会立刻开跑"的 turn；session 正忙时这条消息进排队（既有串行语义，
    // 不产生新并发）。**非订阅行**不受全局固定数限制，只受内存闸 + 防失控上限（quota.js）。
    // ⚠️ 判据是"花不花站主订阅"，不是"这一轮花不花钱"（08-30 改）：那个固定数 3 护的是订阅，
    // 一条 $0.015/M 的 API 行塞进那一档只会把站点默认路径的天花板从 12 砍到 3。
    if (!getQuerySession(sid)?.currentRunId) {
      const gate = checkConcurrency(req.user, { offSubscription: resolveModelRoute(turnModel).mode === 'api' });
      if (!gate.ok) {
        return res.status(429).json({ error: gate.message, code: gate.code });
      }
    }

    // ── 内容外审（2026-08-02）：消息先过分类器再进 agent。拦下 = 零成本，run 都不建。
    // 强度按账号（users.moderation_level，站主在控制台调），判定 / 留证 / 连坐封禁的
    // 口径全在 lib/moderation.js。
    // 没有文字就没有可审的东西（附件本来就不审，见 lib/moderation.js）——
    // 拿空串去问分类器只是白花一次调用和 1 秒。
    //
    // 08-20 起外审档按模型通路取旋钮（订阅 / 本地与中转各一个），所以这里要先知道
    // 这条消息会落在哪个模型上：新会话带 body.model 就是它（白名单校验在下面那段，
    // 这里只是读；非法名最终会 400），否则读该会话的 session-config（新会话没文件
    // → 全局默认）。只读不写 —— 模型持久化仍在外审之后，拦下的消息不该改会话配置。
    if (shouldModerate(req.user, turnModel) && chatText.trim()) {
      const verdict = await moderateText(chatText, levelFor(req.user, turnModel));
      if (!verdict.ok) {
        const rec = recordViolation({
          userId: req.user.id, projectId: project.id,
          category: verdict.category, severity: verdict.severity,
          reason: verdict.reason, excerpt: chatText, level: verdict.level,
        });
        // 上面两道闸的 429 是同步返回，弱网重发撞 in-flight 的窗口可以忽略；
        // 这里 await 了 ~1s，窗口是真的 —— reject 让正在 await 的同 requestId
        // POST fallthrough 自己重跑（然后再被拦一次），不能让它挂死。
        if (typeof requestId === 'string' && requestId) {
          try { if (typeof inflightReject === 'function') inflightReject(new Error('moderation blocked')); } catch { /* */ }
          inflightTurns.delete(requestId);
        }
        return res.status(451).json({
          error: rec?.disabled
            ? '消息涉及违规内容，账号已停用。如有疑问请联系站主'
            : '这条消息涉及违规内容，没有发给 agent。请调整后重发',
          code: 'MODERATION_BLOCKED',
        });
      }
    }

    // 取 sessionRoot + workspace 主动提示：
    //   - pendingSummary（C4）：用户在 chat 间隔做的直接编辑/评论 buffer
    //   （素材摘要 08-21 起由 UserPromptSubmit hook 注入，首轮全量之后只报变化）
    await ensureProjectWorkspace(project.id);
    const sessionRoot = await ensureSessionWorkspace(project.id, sid);

    // 模型选择（可选 body.model）：只用于**新建会话**时把首选模型带进来
    // （首页 / Hub 那条路，会话还不存在，前端只有 localStorage 偏好）。
    //
    // 会话建起来之后模型的真相在 session-config.json，改它走 PUT /sessions/:sid/model。
    // 这里之所以不再无脑接受 body.model：前端每条消息都带偏好的话，在另一台机器上
    // 为这个会话选的模型会被本机的旧偏好悄悄改回去 —— 一次发消息顺带改配置，
    // 用户完全看不见。
    // 没带 body.model 且会话无覆盖 → 默认模型写进会话（否则 session-loop 吃 NODESIGN_MODEL，对公开号是锁着的订阅行）
    const requestedModel = requestedModelEarly || ((!sessionModelEarly.override && !keepLegacyDefault) ? turnModel : null);
    if (requestedModel) {
      // 与 PUT /sessions/:sid/model 同一道闸（2026-08-19 评审抓的洞）：这条路
      // 以前不校验，等于绕过 picker 白名单的后门 —— model-ingress 上线后表里
      // 有带真钥匙的 API 模型（gemini），裸 POST 就能替会话选中它烧上游的钱。
      // 校验用 allowedModelsFor（不含 locked）—— locked 的在上面已经 403 过了。
      if (!allowedModelsFor(modelUserFor(req, project)).some((m) => m.id === requestedModel)) {
        return res.status(400).json({ error: `unknown model: ${requestedModel}`, code: 'UNKNOWN_MODEL' });
      }
      await applySessionModel(sid, getSessionMetaDir(project.id, sid), requestedModel, 'turn');
    }

    const pendingSummary = isNewSession ? { count: 0, summary: '' } : await readPendingSummary(sessionRoot);
    // raw：纯文本直达 SDK，不加任何装饰块 —— 斜杠命令（/compact 等）要求消息
    // 就是命令本身，多包一层 system 注入就不会被识别
    const { displayText, blocks } = raw === true && chatText.trim()
      ? { displayText: chatText.trim(), blocks: [{ type: 'text', text: chatText.trim() }] }
      : await composeUserMessage(chatText, attachments, pendingSummary, sessionRoot);

    // 上传/附件诊断：NODESIGN_DEBUG_TURN=1 时打印 blocks 概况，定位 image 体积/媒体类型
    // 引发的 400/超 token 类问题（配合 binary-fixup-proxy 的 /tmp dump）
    if (process.env.NODESIGN_DEBUG_TURN === '1') {
      const summary = blocks.map((b) => {
        if (b.type === 'image') {
          const dataLen = b.source?.data?.length || 0;
          return `image(${b.source?.media_type},${(dataLen / 1024).toFixed(1)}KB-base64)`;
        }
        return `${b.type}(${(b.text || '').length}c)`;
      });
      console.info(`[turn.compose] sid=${sid.slice(0, 8)} blocks=[${summary.join(', ')}]`);
    }

    // 这条用户消息的 uuid（2026-08-30「回退标识要刷新才出现」案）。
    //
    // 它是 SDKUserMessage.uuid，CLI 会**原样**写进 jsonl（探针实证：push 时盖的
    // uuid 与 jsonl 里那条 user 记录的 uuid 一致），而 rewindFiles / fork 的
    // upToMessageId / truncateJsonlAtMessage 认的都是 jsonl 里那个 uuid。
    //
    // 以前它由 pushUserMessage 在 202 之后临时生成（新会话首条甚至不盖，由 CLI 自己
    // 生成），前端无从知晓 → 乐观插入的气泡只能用本地 `msg_xxx` 做 id → 回退/分叉
    // 按钮的 UUID 判据不认它 → **必须刷新页面**等 hydrate 从 jsonl 读回真 uuid 才出现。
    // 现在改成前端先生成、随请求带来（老前端不带则这里生成），202 也回传一份。
    const userMsgUuid = UUID_RE.test(String(userMessageUuid || '')) ? userMessageUuid : randomUUID();

    // 创建 run（pending）— per-turn record，displayText 落 brief 字段做审计
    const run = createRun({
      skillId: finalSkillId, brief: displayText, projectId: project.id,
      userId: req.user?.id ?? null, sessionId: sid,
    });

    // Phase A.6：写 LRU 让后续重试同 requestId 拿到一致 (runId, sid)
    // 同时 resolve in-flight Promise 通知正在 await 的并发 POST，5s 后清 in-flight
    // entry（让 LRU 接管后续 dedup 查询）。
    if (typeof requestId === 'string' && requestId) {
      lruPut(requestId, { pid: project.id, runId: run.id, sessionId: sid, userMessageId: userMsgUuid });
      if (inflightResolve) {
        inflightResolve({ pid: project.id, runId: run.id, sessionId: sid, userMessageId: userMsgUuid });
      }
      setTimeout(() => inflightTurns.delete(requestId), INFLIGHT_RETENTION_MS);
    }

    // 立即返回，agent 后台跑
    res.status(202).json({ runId: run.id, sessionId: sid, userMessageId: userMsgUuid });
    const bus = getProjectBus(project.id);

    const sdkUserMessage = {
      type: 'user',
      message: { role: 'user', content: blocks },
      parent_tool_use_id: null,
      // 两条路径都盖：pushUserMessage 走 runIdByUuid 认领（它见 uuid 已在就不再生成），
      // startNewRunSession 那条不进认领表（claimRunByUuid 返 null，照旧走 initialRunId）。
      uuid: userMsgUuid,
    };

    if (hasActiveQuerySession(sid)) {
      // streamInput 模式：session 已有 long-running query 在跑 →
      // push 这条 message 进 queue，由 runSession 的 for-await-of 拉走处理。
      // 适用：① 续 chat（agent 已结束上一轮 idle 等）② 用户在 agent 跑时追加消息
      //
      // permissionMode 校正：请求带的 mode 和 SDK 当前 mode 不一致时（例如上一轮
      // agent 自己进了 plan mode，用户直接又发了一条普通消息），pushUserMessage 路径
      // 下 SDK 会按旧 mode 处理新 chat → canUseTool 拦 Write/Edit。这里在 push 前对齐。
      // setPermissionMode 是 SDK 原生 API，可在 turn 边界外调；fail-soft 不阻塞。
      const querySession = getQuerySession(sid);
      const currentMode = querySession?.currentPermissionMode;
      const desiredMode = initialPermissionMode;
      if (currentMode && desiredMode && currentMode !== desiredMode && querySession?.query?.setPermissionMode) {
        try {
          await querySession.query.setPermissionMode(desiredMode);
          setSessionPermissionMode(sid, desiredMode);
          emitPermissionModeChanged(project.id, sid, desiredMode);
        } catch (err) {
          console.warn(`[turn] mode sync failed sid=${sid.slice(0, 8)} (${currentMode}→${desiredMode}): ${err.message}`);
        }
      }
      const ok = pushUserMessage(sid, run.id, sdkUserMessage);
      if (!ok) {
        // race：刚 close 的 session（理论上极少）—— fallback 起新
        console.warn(`[turn] pushUserMessage failed for ${sid.slice(0, 8)}, falling back to new session`);
        startNewRunSession({ runId: run.id, sid, sessionRoot, blocks: sdkUserMessage, eventBus: bus, project, finalSkillId, chat, initialPermissionMode });
      } else {
        // push 后 emit 当前 queue 积压深度，前端显示"已排队 N 条"
        // depth=0 表示 agent idle 立刻处理；depth>0 表示 agent 还在忙，要排队
        const depth = getQueueDepth(sid);
        bus.publish({ type: 'run.queue.depth', sessionId: sid, depth, ts: new Date().toISOString() });
      }
    } else {
      // 没活跃 session → 起新 runSession（首条 message 提前 push 进 queue）
      startNewRunSession({ runId: run.id, sid, sessionRoot, blocks: sdkUserMessage, eventBus: bus, project, finalSkillId, chat, initialPermissionMode });
    }

    // 写回 active_session_id（让下次不带 sessionId 的 turn fallback 续到这个）。
    // setActiveSession **无条件**调：它顺带 bump projects.updated_at，首页
    // 「我的项目」按这个排序 —— 只在指针变化时才写会让"同会话继续聊"不再
    // 把项目顶到最前。
    //
    // E1a（2026-08-13）：指针**实际变化**时广播 project.active_session ——
    // 会话真相源收敛到服务端指针后，同项目其他标签页靠这条事件对齐自己。
    // project 是本请求开头 guardProject 读的库快照，拿它比对够准（写这个
    // 字段的只有 turn 和删会话两条路，都走 HTTP 串行到达）。
    try {
      const pointerChanged = project.activeSessionId !== sid;
      setActiveSession(project.id, sid);
      if (pointerChanged) {
        bus.publish({ ...Events.projectActiveSession(sid), ts: new Date().toISOString() });
      }
    } catch { /* ignore */ }
  } catch (err) {
    // 处理失败时通知正在 await in-flight 的并发同 requestId POST：reject + 清 entry
    // 让它们 fallthrough 自己跑（subagent 提的 race 修复完整闭环）。
    try { if (typeof inflightReject === 'function') inflightReject(err); } catch { /* */ }
    const rid = req.body?.requestId;
    if (typeof rid === 'string' && rid) inflightTurns.delete(rid);
    next(err);
  }
});

/**
 * 起一个新的 runSession（streamInput long-running query），并预 push 首条 user
 * message 让 SDK 启动后立即处理。fire-and-forget — 不阻塞 HTTP response。
 */
function startNewRunSession({ runId, sid, sessionRoot, blocks, eventBus, project, finalSkillId, chat, initialPermissionMode }) {
  const inputQueue = new AsyncQueue();
  inputQueue.push(blocks);   // 直接 push 进 queue —— runSession 启动后用 initialRunId 关联

  runSession({
    sessionId: sid,
    projectId: project.id,
    ownerId: project.ownerId,   // 订阅通路的资格断言在 session-loop 做 OAuth 决策那一行（auth/tier.js）
    sessionWorkspaceRoot: sessionRoot,
    eventBus,
    inputQueue,
    skillId: finalSkillId,
    // 不再传 sessionTitle —— SDK doc:"Custom session title... skips automatic
    // title generation"。让 SDK 用 ANTHROPIC_SMALL_FAST_MODEL（haiku）自动
    // 总结对话生成标题，前端 run.done 后 refetch sessions 拉新 summary。
    // 用户主动 rename（未来 ✏️ 按钮）走 SDK renameSession() 单独路径。
    initialRunId: runId,
    initialPermissionMode,
  })
    .then(() => {
      console.info(`[turn] runSession ${sid.slice(0, 8)} ended cleanly`);
    })
    .catch((err) => {
      // session 抛错：query 可能挂了，前端通过 run.error event 看到
      console.error(`[turn] runSession ${sid.slice(0, 8)} failed:`, err.message);
    });
}

/**
 * POST /api/projects/:pid/runs/:runId/cancel
 *
 * 用户点"停止生成"按钮 → 触发活跃 run 的 AbortController.abort()。
 * SDK 看到 abort signal → query 中断 → session-loop try/catch 走 aborted 路径
 * → emit run.cancelled 事件给前端。
 *
 * 200 { ok: true }                  成功 trigger abort
 * 404 { error: 'run not active' }  runId 不在 registry（已结束 / 不存在）
 */
router.post('/:pid/runs/:runId/cancel', async (req, res, next) => {
  try {
    const project = guardProject(req, res);
    if (!project) return;
    if (!guardRunInProject(req, res)) return;

    const { runId } = req.params;
    const ok = cancelRun(runId, 'user_cancel');
    if (!ok) {
      return res.status(404).json({
        error: 'run not active or already finished',
        code: 'RUN_NOT_ACTIVE',
      });
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * A4.2：POST /api/projects/:pid/runs/:runId/answer
 *
 * 用户在 AskUserQuestionView 卡片点选项 → 前端 POST 来这个 endpoint →
 * provideAnswer resolve 对应 toolUseId 的 Promise → session-loop.js canUseTool
 * 返回 { behavior: 'allow', updatedInput: { ...input, answers } } → SDK
 * binary 调 tool.call → 模型看到 "User has answered: q1=A"。
 *
 * Body：
 *   {
 *     toolUseId: string,            // run.ask_user_question 事件带的
 *     answers: { [questionText]: optionLabel }  // multi-select 用 ", " 拼
 *   }
 *
 * 200 { ok: true }                            成功 resolve
 * 404 { error, code: 'NO_PENDING_QUESTION' }  run/toolUseId 不在 pending
 *                                             （已答 / 已 cancel / 已结束）
 * 400 { error }                               body 缺字段
 */
router.post('/:pid/runs/:runId/answer', async (req, res, next) => {
  try {
    const project = guardProject(req, res);
    if (!project) return;
    if (!guardRunInProject(req, res)) return;

    const { runId } = req.params;
    const { toolUseId, answers } = req.body || {};
    if (!toolUseId || typeof toolUseId !== 'string') {
      return res.status(400).json({ error: 'toolUseId required (string)' });
    }
    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({ error: 'answers required (object: { [questionText]: label })' });
    }

    const ok = provideAnswer(runId, toolUseId, answers);
    if (!ok) {
      return res.status(404).json({
        error: 'no pending question for this run/toolUseId',
        code: 'NO_PENDING_QUESTION',
      });
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * Phase B 批次 4：POST /api/projects/:pid/runs/:runId/elicit/:reqId/answer
 *
 * MCP 工具调 server.elicitInput() 时 SDK 触发 onElicitation 回调，回调 emit
 * run.elicitation_request 事件让前端弹 Modal。用户填完后 POST 这个 endpoint
 * → provideElicitation resolve session-loop.js 里 await 的 Promise
 * → SDK 拿到 { action, content } 继续工具调用。
 *
 * Body:
 *   {
 *     action: 'accept' | 'decline' | 'cancel',
 *     content?: { [field]: any }  // accept 时用户填的表单字段
 *   }
 *
 * 200 { ok: true }
 * 404 { error, code: 'NO_PENDING_ELICITATION' }
 * 400 { error }
 */
router.post('/:pid/runs/:runId/elicit/:reqId/answer', async (req, res, next) => {
  try {
    const project = guardProject(req, res);
    if (!project) return;
    if (!guardRunInProject(req, res)) return;

    const { runId, reqId } = req.params;
    const { action, content } = req.body || {};
    if (!action || !['accept', 'decline', 'cancel'].includes(action)) {
      return res.status(400).json({ error: 'action required (accept|decline|cancel)' });
    }

    const ok = provideElicitation(runId, reqId, { action, content });
    if (!ok) {
      return res.status(404).json({
        error: 'no pending elicitation for this run/reqId',
        code: 'NO_PENDING_ELICITATION',
      });
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────
// SDK Query control method endpoints（sdk.d.ts:2017 Query interface）
// 这些方法只在 streaming input/output 模式下可用 — session-loop.js 唯一入口
// 已让所有 run 走 AsyncIterable<SDKUserMessage>（buildUserMessageStream）满足前提。
// ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/projects/:pid/runs/:runId/rewind
 *
 * 配合 sdkOptions.enableFileCheckpointing —— 把 cwd 文件回滚到指定 user
 * message 时点 + session JSONL 截断到该 message。前端 user message 旁的
 * undo 按钮调这个 endpoint。
 *
 * Body: { messageId: string }  - SDKAssistantMessage.uuid 或 user message uuid
 *
 * 注意：rewindFiles 不主动 git revert（git 不在 SDK 管辖）→ 用户用 undo 后
 * 产物文件落后 git history 一步；前端可以 hint 或 host 端补 commit。
 */
router.post('/:pid/runs/:runId/rewind', async (req, res, next) => {
  try {
    const project = guardProject(req, res);
    if (!project) return;
    if (!guardRunInProject(req, res)) return;

    const { runId } = req.params;
    const { messageId } = req.body || {};
    if (!messageId || typeof messageId !== 'string') {
      return res.status(400).json({ error: 'messageId required (string)' });
    }

    const query = getQuery(runId);
    if (!query) {
      return res.status(404).json({
        error: 'run not active or query handle not yet attached',
        code: 'RUN_NOT_ACTIVE',
      });
    }
    if (typeof query.rewindFiles !== 'function') {
      return res.status(501).json({
        error: 'SDK query handle missing rewindFiles method (older SDK?)',
        code: 'METHOD_NOT_AVAILABLE',
      });
    }

    const result = await query.rewindFiles(messageId);
    res.json({ ok: true, result });
  } catch (err) { next(err); }
});

import { hotSwitchModelHandler } from './turn-model-switch.js';
import { msg } from '../shared/messages.js';

/** 运行中热切模型（实现连同它那三道闸搬去了 turn-model-switch.js） */
router.post('/:pid/runs/:runId/model', hotSwitchModelHandler);


// 注：POST /image-approval 路由已删除（2026-05-06）。原本配 ImageApprovalBanner
// 走 approve/regenerate/dismiss 三按钮 gate，但实际上 emit 完即返不阻塞 agent，
// 形同弹窗装饰。改为：generate_image 已在 CallToolResult 返 image content block，
// 前端自动渲染；agent 在 caption / 自然回话邀请反馈，下一轮用户 chat 即天然 gate。

export default router;
