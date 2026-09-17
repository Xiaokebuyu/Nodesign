/**
 * server/api/projects.js — Project CRUD
 *
 * GET    /api/projects              列项目（按 updated_at 倒序）
 * POST   /api/projects              { name, skillId?, description? } → 创建 + ensureProjectWorkspace
 * GET    /api/projects/:pid         单项目
 * PATCH  /api/projects/:pid         { name?, skillId?, description? } 部分更新
 * DELETE /api/projects/:pid         删进回收站（09-17 起软删除，保留期后真删；runs 保留）
 * /api/projects/trash/*             回收站：列表 / 恢复 / 立即彻底删除 / 审计（api/project-delete.js）
 *
 * description: 可选，<= 2000 字符。仅 NoDesign 后端/前端 UI 用，agent 不感知
 * （agent 看的是项目级 instruction = workspace/.claude/CLAUDE.md）。
 */

import express from 'express';
import {
  listProjects, createProject, updateProject,
} from '../projects/store.js';
import { guardProject } from './_guard.js';
import { chalkPreview } from '../lib/board-excerpt.js';
import { taskManifest } from '../lib/artifact-target.js';
import { countPublishedByUser } from '../lib/publish-store.js';
import { checkQuota } from '../lib/quota.js';
import { ensureProjectWorkspace, getSharedDir, validateSessionId } from '../projects/workspace.js';
import { getProjectBus } from '../ws/broker.js';
import { Events } from '../engine/agent/events.js';
import { softDeleteProject, trashRouter } from './project-delete.js';
import { trashRetentionDays } from '../projects/project-trash.js';

const router = express.Router();

/**
 * 列表的归属口径：一律只列自己的。
 *
 * 2026-08-03 收窄：原本 admin 拿的是全库，于是「我的项目」首页把所有内测用户的
 * 项目名铺在一起（16 张卡里只有 7 张是自己的）。admin 要看全站有 /admin；
 * 要打开别人的项目 guardProject 仍然放行 —— 越权能力没变，变的是首页的口径：
 * 「我的项目」就是我的。
 */
const ownerScope = (req) => req.user?.id ?? null;

const KIND_VALUES = new Set(['project', 'quick']);
const KIND_QUERY_VALUES = new Set(['project', 'quick', 'all']);
// 项目模式（2026-08-27）：design=设计工作台（现状默认）/ rp=演出（常驻角色演故事）。
// 切换下个会话生效（会话启动时读一次），真相源与工具对照表见 engine/mcp/mode-profile.js。
const MODE_VALUES = new Set(['design', 'rp']);

// GET /api/projects 默认行为（2026-05-07）：不带 ?kind= 时 **只返 kind='project'**，
// 把闪聊（kind='quick'）从主项目列表里挡掉 —— 避免老 client / 任何漏传 kind 的调用
// 把闪聊泄漏到「我的项目」UI。要拿全集显式传 ?kind=all。kind=quick 仍可单独筛。
router.get('/', (req, res, next) => {
  try {
    const raw = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    if (raw && !KIND_QUERY_VALUES.has(raw)) {
      return res.status(400).json({ error: `kind must be project|quick|all (got ${raw})` });
    }
    const effectiveKind = raw === 'all' ? undefined : (raw || 'project');
    // trashRetentionDays：删除确认框要写「N 天内可在最近删除里恢复」，跟列表一趟带回去（09-17）
    res.json({ projects: listProjects({ kind: effectiveKind, owner: ownerScope(req) }), trashRetentionDays: trashRetentionDays() });
  } catch (err) { next(err); }
});

/**
 * GET /api/projects/stats —— 首页卡片那行元信息（这个项目里躺着什么）
 *
 * 卡片上原来印的是 skill_id，全站同一个值 'deskskill-engine-mini'，等于一行噪声。
 * 真正配占那一行的是「这里出了几件东西、都是什么形态」，而这个事实不在库里，
 * 在 workspace 的 tasks/ 目录里。所以单开一条而不是并进列表接口：列项目不能
 * 因为要读一圈磁盘而变慢，前端拿到列表先把卡画出来，这条回来了再补那行字。
 *
 * kind=null 的任务是开了头还没写出产物的，计入 tasks 但不计入 kinds。
 *
 * summary 是首页写在板子上那几笔账（已上线几件、今天花了多少）。搭这趟车而不是
 * 单开端点：首页为了这四行字已经要发一次请求了，没必要发第三次。两个数都是
 * 单条 SQL，不额外读盘。
 *
 * 注意：必须注册在 '/:pid' 之前，否则 'stats' 会被当成项目 id。
 */
router.get('/stats', async (req, res, next) => {
  try {
    const projects = listProjects({ kind: 'project', owner: ownerScope(req) });
    const stats = {};
    await Promise.all(projects.map(async (p) => {
      // 首页卡上的"有几件东西"。扁平化前数的是任务数（每项目恒为 1，
      // 所以那张卡上永远写着 1），现在数**产物**——一个项目里并排的 deck /
      // 目录型产物各算一件，这才是用户眼里的"这个项目里有什么"。
      let artifacts = [];
      try {
        artifacts = (await taskManifest(getSharedDir(p.id)))?.artifacts || [];
      } catch { /* 目录没了：算 0 件 */ }
      const kinds = {};
      for (const a of artifacts) if (a.kind) kinds[a.kind] = (kinds[a.kind] || 0) + 1;
      // 板书不进 artifacts（它不是产物），所以卡上"这里躺着什么"必须单独问一句 ——
      // 不问的话整个演出项目会一直写着"还没出东西"，而里面躺着一整个故事
      const chalk = await chalkPreview(getSharedDir(p.id)).catch(() => null);
      stats[p.id] = { tasks: artifacts.length, kinds, ...(chalk ? { chalk } : {}) };
    }));
    // dev 模式（不要求登录）没有 req.user，这两笔账就没有主语，整块不下发
    const summary = req.user
      ? {
        published: countPublishedByUser(req.user.id),
        usedToday: checkQuota(req.user).usedToday,
      }
      : null;
    res.json({ stats, summary });
  } catch (err) { next(err); }
});

// 回收站（09-17）：必须挂在 '/:pid' 之前，否则 'trash' 会被当成项目 id
router.use('/trash', trashRouter);

const DESCRIPTION_MAX = 2000;

router.post('/', async (req, res, next) => {
  try {
    const { name, skillId, description, kind, mode, autoNamed } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name required' });
    }
    if (description != null && typeof description !== 'string') {
      return res.status(400).json({ error: 'description must be string' });
    }
    if (typeof description === 'string' && description.length > DESCRIPTION_MAX) {
      return res.status(400).json({ error: `description too long (max ${DESCRIPTION_MAX})` });
    }
    if (kind != null && !KIND_VALUES.has(kind)) {
      return res.status(400).json({ error: `kind must be project|quick (got ${kind})` });
    }
    if (mode != null && !MODE_VALUES.has(mode)) {
      return res.status(400).json({ error: `mode must be design|rp (got ${mode})` });
    }
    const project = createProject({
      name, skillId, description, kind, mode: mode ?? undefined, autoNamed: !!autoNamed,
      ownerId: req.user?.id ?? null,
    });
    await ensureProjectWorkspace(project.id);
    res.status(201).json({ project });
  } catch (err) { next(err); }
});

router.get('/:pid', (req, res, next) => {
  try {
    const project = guardProject(req, res);
    if (!project) return;
    res.json({ project });
  } catch (err) { next(err); }
});

router.patch('/:pid', (req, res, next) => {
  try {
    const project = guardProject(req, res);
    if (!project) return;
    const patch = {};
    if (typeof req.body?.name === 'string') patch.name = req.body.name.trim();
    if (typeof req.body?.skillId === 'string') patch.skillId = req.body.skillId;
    if ('description' in (req.body || {})) {
      const d = req.body.description;
      if (d != null && typeof d !== 'string') {
        return res.status(400).json({ error: 'description must be string' });
      }
      if (typeof d === 'string' && d.length > DESCRIPTION_MAX) {
        return res.status(400).json({ error: `description too long (max ${DESCRIPTION_MAX})` });
      }
      patch.description = (typeof d === 'string' && d.trim()) ? d.trim() : null;
    }
    if ('kind' in (req.body || {})) {
      if (!KIND_VALUES.has(req.body.kind)) {
        return res.status(400).json({ error: `kind must be project|quick (got ${req.body.kind})` });
      }
      patch.kind = req.body.kind;
    }
    if ('mode' in (req.body || {})) {
      if (!MODE_VALUES.has(req.body.mode)) {
        return res.status(400).json({ error: `mode must be design|rp (got ${req.body.mode})` });
      }
      patch.mode = req.body.mode;
    }
    // E1a（2026-08-13）：会话真相源收敛到 projects.active_session_id 之后，
    // 前端切会话得能直接写这个指针（此前唯一的写入方是 turn.js —— 不发消息、
    // 只是切着看，指针就不动，别的标签页也就永远对不齐）。接受 null（清空）
    // 或合法 sid 形状；不校验会话是否真实存在 —— 跟 turn.js 对 body.sessionId
    // 的信任口径一致（指错了顶多下次 turn 起新会话）。
    if ('active_session_id' in (req.body || {}) || 'activeSessionId' in (req.body || {})) {
      const v = req.body.active_session_id ?? req.body.activeSessionId ?? null;
      if (v !== null) {
        try { validateSessionId(v); } catch (err) {
          return res.status(400).json({ error: err.message || 'invalid active_session_id' });
        }
      }
      patch.activeSessionId = v;
    }
    // 文件夹项目的信任门答案（2026-09-07）。普通项目没有这道门，传了就是错
    if ('folderTrust' in (req.body || {})) {
      if (!project.folderPath) return res.status(400).json({ error: 'not a folder project', code: 'NOT_FOLDER_PROJECT' });
      if (typeof req.body.folderTrust !== 'boolean') return res.status(400).json({ error: 'folderTrust must be boolean' });
      patch.folderTrust = req.body.folderTrust;
    }
    const updated = updateProject(req.params.pid, patch);
    // 指针**实际变化**才广播（project 是 guardProject 读的更新前快照）。
    // 为什么这条事件不带 sessionId 字段：见 events.js projectActiveSession 注释。
    if ('activeSessionId' in patch && patch.activeSessionId !== project.activeSessionId) {
      try {
        getProjectBus(req.params.pid).publish({
          ...Events.projectActiveSession(patch.activeSessionId),
          ts: new Date().toISOString(),
        });
      } catch (err) {
        console.warn(`[projects] active_session broadcast failed: ${err.message}`);
      }
    }
    res.json({ project: updated });
  } catch (err) { next(err); }
});

router.delete('/:pid', async (req, res, next) => {
  try {
    const project = guardProject(req, res);
    if (!project) return;
    // 09-17（问题库 iss_mtjex6wv_5xhn）：删进回收站，不再直接 rm。顺序与原因见 api/project-delete.js 头注
    const r = await softDeleteProject(project, { actor: req.user });
    res.json({ deleted: true, ...r });
  } catch (err) { next(err); }
});

export default router;
