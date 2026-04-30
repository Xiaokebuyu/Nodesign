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
import { validateProjectId, getProject, setActiveSession } from '../projects/store.js';
import { ensureProjectWorkspace } from '../projects/workspace.js';
import { createRun } from '../engine/runs/store.js';
import { runAgent } from '../engine/agent/loop.js';
import { cancelRun } from '../engine/runs/active-runs.js';
import { getProjectBus } from '../ws/broker.js';

const router = express.Router();

router.post('/:pid/turn', async (req, res, next) => {
  try {
    validateProjectId(req.params.pid);
    const project = getProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const { chat, attachments, skillId } = req.body || {};
    if (!chat || typeof chat !== 'string' || !chat.trim()) {
      return res.status(400).json({ error: 'chat string required' });
    }

    const finalSkillId = (typeof skillId === 'string' && skillId) || project.skillId;
    const { displayText, blocks } = composeUserMessage(chat, attachments);

    // 创建 run（pending）— displayText 落 brief 字段做审计 / fallback 显示
    const run = createRun({ skillId: finalSkillId, brief: displayText, projectId: project.id });

    // 立即返回，agent 后台跑
    res.status(202).json({ runId: run.id });

    // 异步启动 agent
    const wsRoot = await ensureProjectWorkspace(project.id);
    const bus = getProjectBus(project.id);

    runAgent({
      runId: run.id,
      skillId: finalSkillId,
      brief: displayText,
      userContentBlocks: blocks,           // C2：走 SDK 多模态 content blocks
      eventBus: bus,
      workspaceRoot: wsRoot,
      resumeSessionId: project.activeSessionId,
    })
      .then(({ snapshot }) => {
        if (snapshot?.sdkSessionId) {
          try { setActiveSession(project.id, snapshot.sdkSessionId); } catch { /* ignore */ }
        }
      })
      .catch((err) => {
        // run.error 已通过 EventBus 推；这里只做 console 留痕
        console.error(`[turn] runAgent failed for ${project.id}/${run.id}:`, err.message);
      });
  } catch (err) { next(err); }
});

/**
 * 把 chat 文本 + attachments 拼成 SDK content blocks 数组。
 *
 * 返回：
 *   - displayText: 用于 createRun 审计 + run.error 时前端显示 fallback
 *   - blocks: BetaContentBlockParam[]（喂 SDK 的 user message content）
 *
 * 当前策略（按用户拍版）：附件统一用文本路径塞 content block，让 agent
 * 用 Read 工具读取（不内联 base64 image，避免大文件爆 user message token）。
 *
 * 未来扩展：
 *   - anchor 类型（D 流）：text 描述选中元素的语义路径（page+tag+text）
 *   - comment 类型（D 流）：text 描述评论内容 + anchor 序列化
 *   - 如果某天要让 agent 一次看图（不用 Read 工具）：加 image content block
 *     { type: 'image', source: { type: 'base64', media_type, data } }
 */
function composeUserMessage(chat, attachments) {
  const blocks = [{ type: 'text', text: chat }];

  if (Array.isArray(attachments) && attachments.length > 0) {
    const lines = [];
    for (const a of attachments) {
      if (!a || typeof a !== 'object') continue;
      if (a.type === 'asset' || a.path) {
        lines.push(`- ${a.path}${a.name ? `（${a.name}）` : ''}`);
      } else if (a.type === 'anchor') {
        lines.push(`- 选中元素: page=${a.pageIndex} ${a.tag || 'element'} ${a.text ? `"${a.text}"` : ''}`);
      } else if (a.type === 'comment') {
        lines.push(`- 评论: ${a.text} (anchor: ${JSON.stringify(a.anchor || {})})`);
      }
    }
    if (lines.length > 0) {
      blocks.push({
        type: 'text',
        text: `可用素材（用 Read 工具读取，路径相对 workspace）：\n${lines.join('\n')}`,
      });
    }
  }

  // displayText：合并 blocks 用 \n\n，给 DB 审计 / fallback 显示用
  const displayText = blocks.map((b) => b.text || `[${b.type}]`).join('\n\n');

  return { displayText, blocks };
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

export default router;
