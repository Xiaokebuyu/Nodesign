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
 *   2. 拼 brief 字符串（chat + 附件元信息前缀）
 *   3. createRun（pending） — projectId 写入
 *   4. 立即返回 runId（agent 异步在后端跑）
 *   5. 后台 runAgent：cwd = project workspace，事件流走 project EventBus
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
    const brief = composeBrief(chat, attachments);

    // 创建 run（pending）— 关联 project
    const run = createRun({ skillId: finalSkillId, brief, projectId: project.id });

    // 立即返回，agent 后台跑
    res.status(202).json({ runId: run.id });

    // 异步启动 agent
    const wsRoot = await ensureProjectWorkspace(project.id);
    const bus = getProjectBus(project.id);

    runAgent({
      runId: run.id,
      skillId: finalSkillId,
      brief,
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

/** 把 chat 文本 + attachments 元信息拼成 brief 字符串前缀给 agent */
function composeBrief(chat, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return chat;

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

  if (lines.length === 0) return chat;

  return `可用素材：\n${lines.join('\n')}\n\n---\n\n${chat}`;
}

export default router;
