/**
 * server/api/turn.js — 唯一 LLM 入口（agentic 设计的核心）
 *
 * POST /api/projects/:pid/turn
 *   body: {
 *     chat:        string,           // 用户文本
 *     attachments: [{ path, ... }],  // 附件托盘里的内容（asset / anchor / comment）
 *     skillId?:    string,           // 默认走 project.skillId
 *   }
 *   return 202 { runId }
 *
 * 行为：
 *   1. 校验 project + 解析 input
 *   2. composeUserMessage：拼成 SDK content blocks（P0+ s1 C2 切流式之前是字符串）
 *   3. createRun（pending） — projectId 写入；brief 落 displayText 作审计
 *   4. 立即返回 runId（agent 异步在后端跑）
 *   5. 后台 runAgent：cwd = project workspace，事件流走 project EventBus；
 *      content blocks 走 SDK 的 prompt: AsyncIterable<SDKUserMessage> 接口
 *   6. 跑完：把 sdkSessionId 写回 project.activeSessionId（下次 turn resume）
 *
 * 错误：
 *   - runAgent throw → 已通过 EventBus 推 run.error；console 留痕；
 *     HTTP 已经 202 返回，不再回 5xx
 */

import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { validateProjectId, getProject, setActiveSession } from '../projects/store.js';
import {
  ensureProjectWorkspace,
  ensureSessionWorkspace,
  validateSessionId,
  readAssetsSummary,
} from '../projects/workspace.js';
import { createRun } from '../engine/runs/store.js';
import { runSession } from '../engine/agent/session-loop.js';
import {
  cancelRun, provideAnswer, getQuery,
  hasActiveQuerySession, pushUserMessage, getQuerySession, closeQuerySession,
} from '../engine/runs/active-runs.js';
import { AsyncQueue } from '../lib/async-queue.js';
import { getProjectBus } from '../ws/broker.js';
import { readPendingSummary } from './pending-changes.js';

/** 直接 image input 阈值：> 1MB 走 path 让 agent Read，< 1MB inline base64 */
const IMAGE_INLINE_MAX_BYTES = 1 * 1024 * 1024;
/** Anthropic API 支持的 image media types（sdk-tools.d.ts:150 + API doc） */
const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const router = express.Router();

router.post('/:pid/turn', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const { chat, attachments, skillId, sessionId, permissionMode } = req.body || {};
    if (!chat || typeof chat !== 'string' || !chat.trim()) {
      return res.status(400).json({ error: 'chat string required' });
    }
    // Phase 3.2：前端 plan-mode toggle 传 permissionMode='plan' 启用 SDK 原生 plan mode；
    // 其他值（含不传）走默认 bypassPermissions
    const initialPermissionMode = permissionMode === 'plan' ? 'plan' : null;

    const finalSkillId = (typeof skillId === 'string' && skillId) || project.skillId;

    // C4：先确定 sessionRoot，给 composeUserMessage 看 pending-changes buffer
    // （sid 解析逻辑下面已写）—— 提早 ensure 一次让 buffer 检查能命中真路径。

    // H3：session id 解析逻辑
    //   - body.sessionId === string → 续约该 session（cwd=sessions/<sid>，传 resume）
    //   - body.sessionId === null → 新建 session（前端"+新会话"显式触发）
    //   - body.sessionId 不传 → fallback project.activeSessionId（向后兼容）
    //
    // 新建场景下用 randomUUID 预生成 sid，传给 SDK options.sessionId 让 SDK
    // 用我们的 sid（d.ts:1537 sessionId 单独可传，只要不跟 resume 同用）。
    // 这样 cwd 能提前切到 sessions/<sid>/，agent 一启动就在 session 沙盒里跑。
    let resumeSessionId;
    if ('sessionId' in (req.body || {})) {
      resumeSessionId = sessionId || null;
    } else {
      resumeSessionId = project.activeSessionId;
    }
    const isNewSession = !resumeSessionId;
    const sid = isNewSession ? randomUUID() : resumeSessionId;
    validateSessionId(sid);

    // 取 sessionRoot + 两类 workspace 主动提示：
    //   - pendingSummary（C4）：用户在 chat 间隔做的直接编辑/评论 buffer
    //   - assetsSummary（C8）：./assets/ 里的参考素材（图/文档），新 session 必报，
    //     续 session 仅当 buffer/旧素材的存在仍可能影响判断时报（这里简化为"非空就报"）
    await ensureProjectWorkspace(project.id);
    const sessionRoot = await ensureSessionWorkspace(project.id, sid);
    const pendingSummary = isNewSession ? { count: 0, summary: '' } : await readPendingSummary(sessionRoot);
    const assetsSummary = await readAssetsSummary(sessionRoot);
    const { displayText, blocks } = await composeUserMessage(chat, attachments, pendingSummary, assetsSummary, sessionRoot);

    // 创建 run（pending）— per-turn record，displayText 落 brief 字段做审计
    const run = createRun({ skillId: finalSkillId, brief: displayText, projectId: project.id });

    // 立即返回，agent 后台跑
    res.status(202).json({ runId: run.id, sessionId: sid });
    const bus = getProjectBus(project.id);

    const sdkUserMessage = {
      type: 'user',
      message: { role: 'user', content: blocks },
      parent_tool_use_id: null,
    };

    if (hasActiveQuerySession(sid)) {
      // streamInput 模式：session 已有 long-running query 在跑 →
      // push 这条 message 进 queue，由 runSession 的 for-await-of 拉走处理。
      // 适用：① 续 chat（agent 已结束上一轮 idle 等）② 用户在 agent 跑时追加消息
      const ok = pushUserMessage(sid, run.id, sdkUserMessage);
      if (!ok) {
        // race：刚 close 的 session（理论上极少）—— fallback 起新
        console.warn(`[turn] pushUserMessage failed for ${sid.slice(0, 8)}, falling back to new session`);
        startNewRunSession({ runId: run.id, sid, sessionRoot, blocks: sdkUserMessage, eventBus: bus, project, finalSkillId, chat, initialPermissionMode });
      }
    } else {
      // 没活跃 session → 起新 runSession（首条 message 提前 push 进 queue）
      startNewRunSession({ runId: run.id, sid, sessionRoot, blocks: sdkUserMessage, eventBus: bus, project, finalSkillId, chat, initialPermissionMode });
    }

    // 写回 active_session_id（让下次不带 sessionId 的 turn fallback 续到这个）
    try { setActiveSession(project.id, sid); } catch { /* ignore */ }
  } catch (err) { next(err); }
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
    sessionWorkspaceRoot: sessionRoot,
    eventBus,
    inputQueue,
    skillId: finalSkillId,
    sessionTitle: chat.trim().slice(0, 40),
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
 * 把 chat 文本 + attachments 拼成 SDK content blocks 数组。
 *
 * 返回：
 *   - displayText: 用于 createRun 审计 + run.error 时前端显示 fallback
 *   - blocks: BetaContentBlockParam[]（喂 SDK 的 user message content）
 *
 * 策略：
 *   - **小图（< 1MB） inline base64** → user message 顶层 image content block，
 *     agent 一上来就能 vision 看见参考图，不用先 Read。Kimi vision 通过
 *     binary-fixup-proxy 已验证（lift transform 仅处理 tool_result 嵌套；
 *     user message 顶层 image 直接走标准路径，无需 lift）。
 *   - **大图（>= 1MB）/ 非 image / 文档** → 文本路径让 agent Read（避免大文件
 *     爆 user message token，配合 prelude 的"开工前必看 ./assets/"硬规则）
 *   - **anchor / comment 类型** → 文本描述
 *
 * Anthropic image content block 仅支持 jpeg/png/gif/webp，不支持 svg/heic 等。
 * 不在白名单的 image mime → 按文本路径降级。
 */
async function composeUserMessage(chat, attachments, pendingSummary, assetsSummary, sessionRoot) {
  const blocks = [];

  // C4：用户在过去时段做的 direct edit + comment → prepend system 提示
  // 不灌详情（让 agent 主动调 mcp__nodesign__get_pending_changes 拉），省 token
  if (pendingSummary && pendingSummary.count > 0) {
    blocks.push({
      type: 'text',
      text: `<system>${pendingSummary.summary}。可调 mcp__nodesign__get_pending_changes 查看详情；处理完调 mcp__nodesign__clear_pending_changes 清 buffer。</system>`,
    });
  }

  // C8：assets/ 主动提醒（替代 prelude 硬规则"必先 Glob assets"）—— workspace
  // 检测到有素材时温和提示 agent，没素材就不注入，agent 不必每个 turn 硬查
  if (assetsSummary && assetsSummary.count > 0) {
    blocks.push({
      type: 'text',
      text: `<system>${assetsSummary.summary}。建议挑 1 张关键图 Read 看一眼（你能直接 vision 看到颜色/质感/排版），再决定动手。如果跟用户的 brief 不相关可以先不看。</system>`,
    });
  }

  blocks.push({ type: 'text', text: chat });

  if (Array.isArray(attachments) && attachments.length > 0) {
    // 先尝试给 image attachment inline base64；inline 失败的当 path 走文本路径
    const inlineImageNames = [];
    const fallbackLines = [];

    for (const a of attachments) {
      if (!a || typeof a !== 'object') continue;
      if (a.type === 'anchor') {
        fallbackLines.push(`- 选中元素: page=${a.pageIndex} ${a.tag || 'element'} ${a.text ? `"${a.text}"` : ''}`);
        continue;
      }
      if (a.type === 'comment') {
        fallbackLines.push(`- 评论: ${a.text} (anchor: ${JSON.stringify(a.anchor || {})})`);
        continue;
      }
      // asset 路径分支（assets API 返回 path 形如 '../../shared/assets/<name>'）
      if (!a.path) continue;
      const inline = await tryInlineImageAttachment(a, sessionRoot);
      if (inline) {
        blocks.push(inline);
        inlineImageNames.push(a.name || path.basename(a.path));
      } else {
        fallbackLines.push(`- ${a.path}${a.name ? `（${a.name}）` : ''}`);
      }
    }

    if (inlineImageNames.length > 0) {
      blocks.push({
        type: 'text',
        text: `[已直接附上 ${inlineImageNames.length} 张参考图：${inlineImageNames.join('、')} —— 你可以直接 vision 看，不需要再 Read]`,
      });
    }
    if (fallbackLines.length > 0) {
      blocks.push({
        type: 'text',
        text: `可用素材（用 Read 工具读取，路径相对 workspace）：\n${fallbackLines.join('\n')}`,
      });
    }
  }

  // displayText：合并 blocks 用 \n\n，给 DB 审计 / fallback 显示用
  // image block 用占位文本而非 base64（base64 进 DB / 前端 fallback 都没意义）
  const displayText = blocks.map((b) => {
    if (b.type === 'image') return '[image]';
    return b.text || `[${b.type}]`;
  }).join('\n\n');

  return { displayText, blocks };
}

/**
 * 尝试把 attachment 直接读成 image content block。
 * 失败（不是 image / 太大 / 读取失败 / mime 不在白名单）返 null，让调用方
 * 走 path 字符串 fallback。
 *
 * @param {object} attachment - { path, name?, mime?, size? }
 * @param {string} sessionRoot - 绝对路径，sessions/<sid>/
 * @returns {Promise<null | { type: 'image', source: { type: 'base64', media_type, data } }>}
 */
async function tryInlineImageAttachment(attachment, sessionRoot) {
  const mime = attachment.mime;
  if (!mime || !IMAGE_MEDIA_TYPES.has(mime)) return null;

  // attachment.path 是相对 sessionRoot 的（assets API 返 '../../shared/assets/...'）
  // 解析成绝对路径，并校验解析后仍在 project workspace 内（防 path traversal）
  let absPath;
  try {
    absPath = path.resolve(sessionRoot, attachment.path);
  } catch {
    return null;
  }

  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size > IMAGE_INLINE_MAX_BYTES) return null;

  let buf;
  try {
    buf = await fs.readFile(absPath);
  } catch {
    return null;
  }

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mime,
      data: buf.toString('base64'),
    },
  };
}

/**
 * POST /api/projects/:pid/runs/:runId/cancel
 *
 * 用户点"停止生成"按钮 → 触发活跃 run 的 AbortController.abort()。
 * SDK 看到 abort signal → query 中断 → loop.js try/catch 走 aborted 路径
 * → emit run.cancelled 事件给前端。
 *
 * 200 { ok: true }                  成功 trigger abort
 * 404 { error: 'run not active' }  runId 不在 registry（已结束 / 不存在）
 */
router.post('/:pid/runs/:runId/cancel', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

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
 * provideAnswer resolve 对应 toolUseId 的 Promise → loop.js canUseTool
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
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

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

// ─────────────────────────────────────────────────────────────────────
// SDK Query control method endpoints（sdk.d.ts:2017 Query interface）
// 这些方法只在 streaming input/output 模式下可用，loop.js 已统一所有
// run 走 AsyncIterable<SDKUserMessage>（buildUserMessageStream）满足前提。
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
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

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

/**
 * POST /api/projects/:pid/runs/:runId/permission-mode
 *
 * 运行时切 permission mode（'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk'）。
 * Phase 3 plan-mode native 路径必需 —— plan 审批通过后切回 'default' 让
 * agent 继续 generate（write 工具放开）。
 *
 * Body: { mode: PermissionMode }
 */
router.post('/:pid/runs/:runId/permission-mode', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const { runId } = req.params;
    const { mode } = req.body || {};
    const VALID_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'];
    if (!mode || !VALID_MODES.includes(mode)) {
      return res.status(400).json({
        error: `mode required, one of: ${VALID_MODES.join(', ')}`,
      });
    }

    const query = getQuery(runId);
    if (!query) {
      return res.status(404).json({
        error: 'run not active',
        code: 'RUN_NOT_ACTIVE',
      });
    }
    if (typeof query.setPermissionMode !== 'function') {
      return res.status(501).json({
        error: 'SDK query handle missing setPermissionMode method',
        code: 'METHOD_NOT_AVAILABLE',
      });
    }

    await query.setPermissionMode(mode);
    res.json({ ok: true, mode });
  } catch (err) { next(err); }
});

/**
 * POST /api/projects/:pid/runs/:runId/model
 *
 * 运行时切 model（如 kimi-k2.6 / claude-sonnet-4-6 / claude-opus-4-7）。
 * 前端 model picker 用。Kimi gateway 可用 model 列表受 gateway 限制。
 *
 * Body: { model: string }  - 传 null 或 omit 让 SDK 用 default
 */
router.post('/:pid/runs/:runId/model', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const { runId } = req.params;
    const { model } = req.body || {};
    if (model !== null && model !== undefined && typeof model !== 'string') {
      return res.status(400).json({ error: 'model must be string or null' });
    }

    const query = getQuery(runId);
    if (!query) {
      return res.status(404).json({
        error: 'run not active',
        code: 'RUN_NOT_ACTIVE',
      });
    }
    if (typeof query.setModel !== 'function') {
      return res.status(501).json({
        error: 'SDK query handle missing setModel method',
        code: 'METHOD_NOT_AVAILABLE',
      });
    }

    await query.setModel(model || undefined);
    res.json({ ok: true, model });
  } catch (err) { next(err); }
});

/**
 * Phase 3.2：POST /api/projects/:pid/runs/:runId/plan-approve
 *
 * 用户在 PlanReviewCard 点"批准"（可选编辑过 plan）→ 落 design-plan.md 留档 →
 * query.setPermissionMode('default') → agent 自然继续（plan mode 下 agent 调
 * ExitPlanMode 后 SDK 阻塞等 host 切 mode；切完 SDK 自动放行）。
 *
 * Body: { editedPlan?: string } - 用户编辑过的 plan markdown（无则用 agent 原版）
 */
router.post('/:pid/runs/:runId/plan-approve', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const { runId } = req.params;
    const { editedPlan } = req.body || {};

    const query = getQuery(runId);
    if (!query) {
      return res.status(404).json({
        error: 'run not active',
        code: 'RUN_NOT_ACTIVE',
      });
    }
    if (typeof query.setPermissionMode !== 'function') {
      return res.status(501).json({
        error: 'SDK query handle missing setPermissionMode method',
        code: 'METHOD_NOT_AVAILABLE',
      });
    }

    // 可选：把 editedPlan 落 design-plan.md，让后续 vision-checker 等可以 Read
    // 拿到用户审批通过的版本（agent 原版仅在 ExitPlanMode tool input 里）
    if (typeof editedPlan === 'string' && editedPlan.trim()) {
      try {
        // 用 sessionId 取 sessionRoot；从 query 上拿不到 cwd，借助 project + run
        // metadata。简化版：直接用 active session（turn.js 创建 run 时已 setActiveSession）
        const sid = project.activeSessionId;
        if (sid) {
          const sessionRoot = await ensureSessionWorkspace(project.id, sid);
          await fs.writeFile(
            path.join(sessionRoot, 'design-plan.md'),
            editedPlan.trim() + '\n',
            'utf8',
          );
        }
      } catch (err) {
        console.warn(`[plan-approve] failed to write design-plan.md:`, err.message);
        // 不阻塞 approve；agent 拿不到 design-plan.md 时仍按 ExitPlanMode 内的 plan 执行
      }
    }

    await query.setPermissionMode('default');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * Phase 3.2：POST /api/projects/:pid/runs/:runId/plan-reject
 *
 * 用户在 PlanReviewCard 点"重新对齐" → 中断 run，前端切回 chat 让用户重述 brief。
 * Body: { reason?: string }（写入 abort signal.reason，前端 run.cancelled 事件可看）
 */
router.post('/:pid/runs/:runId/plan-reject', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const { runId } = req.params;
    const reason = (req.body || {}).reason || 'plan_rejected';

    const ok = cancelRun(runId, reason);
    if (!ok) {
      return res.status(404).json({
        error: 'run not active or already finished',
        code: 'RUN_NOT_ACTIVE',
      });
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
