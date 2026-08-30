/**
 * server/api/sessions.js — Session CRUD（H3：session-scoped workspace）
 *
 * GET    /api/projects/:pid/sessions                列项目所有 session（自实现）
 * GET    /api/projects/:pid/sessions/:sid           SDK getSessionMessages
 * POST   /api/projects/:pid/sessions/:sid/fork      SDK forkSession + 复制产物
 * PATCH  /api/projects/:pid/sessions/:sid           SDK rename + tag
 * DELETE /api/projects/:pid/sessions/:sid           SDK deleteSession + 删 session 目录
 *
 * H3 改造：每个 session 独立工作目录 sessions/<sid>/，CLAUDE_CONFIG_DIR
 * per-session（sessions/<sid>/.claude/）。SDK listSessions 按 cwd encoded path
 * 索引 jsonl，跨 session 列要自己 readdir sessions/ 后 per-sid getSessionInfo。
 */

import express from 'express';
import path from 'path';
import { promises as fs } from 'fs';
import {
  getSessionInfo,
  getSessionMessages,
  forkSession,
  renameSession,
  tagSession,
  deleteSession,
} from '@anthropic-ai/claude-agent-sdk';
import { validateProjectId, getProject, setActiveSession } from '../projects/store.js';
import { guardProject, modelUserFor } from './_guard.js';
import { closeQuerySession, hasActiveQuerySession, getQuerySession } from '../engine/runs/active-runs.js';
import {
  getProjectWorkspace,
  getWorkspaceRoot,
  getSessionWorkspace,
  ensureSessionWorkspace,
  forkSessionWorkspace,
  removeSessionWorkspace,
  validateSessionId,
  getSessionMetaDir,
  encodeCwdForSDK,
} from '../projects/workspace.js';
import { withConfigDir } from '../lib/sdk-session.js';
import { patchBoard } from '../projects/board-store.js';
import { platform } from '../runtime/platform.js';
import { getProjectBus } from '../ws/broker.js';
import { getLastContextUsage } from '../engine/runs/live-turn.js';
import { Events } from '../engine/agent/events.js';
import { resolveSessionModel, applySessionModel, defaultModel } from '../engine/agent/session-model.js';
import { selectableModelsFor, allowedModelsFor, isModelLockedFor, defaultModelFor, modelSwitchRejection } from '../engine/agent/model-context.js';


import { mountRewindRoute } from './sessions-rewind.js';
import { jsonlExistsForSession, truncateJsonlAtLastUserMessage } from '../projects/session-jsonl.js';

const router = express.Router();

// 「回到某条消息之前」整块住在 sessions-rewind.js（行数棘轮，2026-08-30 拆出）
mountRewindRoute(router);

// SDK session API 需要 CLAUDE_CONFIG_DIR 指向 JSONL 实际存储的全局目录
// 来自 runtime/platform.js（跨平台决策单一来源）
const GLOBAL_CLAUDE_CONFIG_DIR = platform.claudeConfigDir;

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 列指定 project 的所有 session（按 lastModified 倒序）。共享给：
 * 1. GET /api/projects/:pid/sessions（这文件下面的路由）
 * 2. GET /api/sessions/recent（recent.js 跨项目聚合）
 *
 * 后端实现：readdir sessions/ → 对每个 sid 调 SDK getSessionInfo
 * （per-session CLAUDE_CONFIG_DIR）→ filter null → sort by lastModified。
 *
 * @param {string} pid
 * @returns {Promise<object[]>} sessions 数组（每条至少含 sessionId / lastModified；
 *   SDK 还会补 customTitle / summary / firstPrompt / tag 等字段）
 */
export async function listSessionsForProject(pid) {
  // 会话的落脚点在 2026-08-08 扁平化时搬了家：`<项目>/sessions/<sid>/`（每会话
  // 一个沙盒）→ `<工作区>/.nd/<sid>/`（只剩私档，cwd 是工作区本身）。
  //
  // ⚠️ 这里漏改过一次，后果是**迁移之后会话列表永远为空** —— 界面上历史对话
  // 全部消失（数据没丢，`.nd/` 和转录都在，只是没人去列）。所以两处都读：
  // 迁移过的看 `.nd/`，没迁移的看老的 `sessions/`。
  const workspaceRoot = getWorkspaceRoot(pid);
  const readSids = async (dir) => {
    try {
      return (await fs.readdir(dir, { withFileTypes: true }))
        .filter(e => e.isDirectory() && SESSION_ID_RE.test(e.name)).map(e => e.name);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  };
  const sids = [...new Set([
    ...await readSids(path.join(workspaceRoot, '.nd')),
    ...await readSids(path.join(getProjectWorkspace(pid), 'sessions')),
  ])];
  const results = await Promise.all(sids.map(async (sid) => {
    // 转录按 **cwd** 编码定位，而 cwd 现在就是工作区（getSessionWorkspace 也返回它）
    const sessionRoot = workspaceRoot;
    try {
      const info = await withConfigDir(GLOBAL_CLAUDE_CONFIG_DIR, () =>
        getSessionInfo(sid, { dir: sessionRoot }),
      );
      return info || null;
    } catch (err) {
      console.warn(`[sessions list] ${sid.slice(0, 8)} info failed:`, err.message);
      return null;
    }
  }));
  return results
    .filter(Boolean)
    .sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
}

// ── List：自实现（readdir sessions/ + per-sid getSessionInfo）──
router.get('/:pid/sessions', async (req, res, next) => {
  try {
    const project = guardProject(req, res);
    if (!project) return;

    const all = await listSessionsForProject(req.params.pid);

    const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : all.length;
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    const sessions = all.slice(offset, offset + limit);

    res.json({ sessions });
  } catch (err) { next(err); }
});

// ── Read：单 session messages ──
router.get('/:pid/sessions/:sid', async (req, res, next) => {
  try {
    validateSessionId(req.params.sid);
    const project = guardProject(req, res);
    if (!project) return;

    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);

    const includeSystemMessages = req.query.includeSystem === '1';

    const messages = await withConfigDir(GLOBAL_CLAUDE_CONFIG_DIR, () =>
      getSessionMessages(req.params.sid, {
        dir: sessionRoot,
        includeSystemMessages,
      }),
    );
    res.json({ messages });
  } catch (err) { next(err); }
});

/**
 * ── 上下文用量（按需查询）──
 *
 * run.context_usage 是 turn 内推的，turn 一结束前端就只剩一个空值。可用户想看
 * "现在装了多少、要不要压缩"恰恰是在两轮之间。composer 的 [+] 菜单展开时打这条。
 *
 * 两个来源，优先级从高到低：
 *   1. query 还活着 → 直接向 SDK 现问（streamInput 模式下 query 在 turn 之间不死），
 *      这是权威值
 *   2. query 已经没了 → 内存里记着的最后一次事件，标 live:false 让前端说明白
 * 都没有 → 204，前端显示"还没开始对话"。
 */
router.get('/:pid/sessions/:sid/context-usage', async (req, res, next) => {
  try {
    validateSessionId(req.params.sid);
    const project = guardProject(req, res);
    if (!project) return;

    const sid = req.params.sid;
    const qs = getQuerySession(sid);
    if (typeof qs?.query?.getContextUsage === 'function') {
      try {
        const usage = await qs.query.getContextUsage();
        // appModel 决定分母（真实容量 vs SDK 的 compact 触发线），跟 turn 内推的
        // 事件走同一个构造函数，前端拿到的两份数据形状一致。
        // 模型从 session-config 现读 —— 原来这里问的是 querySession.ctx?.appModel，
        // 而那个 ctx 字段从注册起就是 null 且无人填写，那一支永远走不到，分母只能
        // 掉回 SDK 的 compact 触发线，同一个会话两次读数对不上。
        const { model: appModel } = await resolveSessionModel(getSessionMetaDir(req.params.pid, sid));
        if (usage) return res.json({ ...Events.contextUsage(usage, appModel), live: true });
      } catch (err) {
        // SDK 拒答不算错（query 正在收尾等）—— 掉到记忆值上，别把菜单打成红的
        console.warn(`[sessions] getContextUsage failed sid=${sid.slice(0, 8)}: ${err.message}`);
      }
    }

    const remembered = getLastContextUsage(sid);
    if (remembered) return res.json({ ...remembered, live: false });
    return res.status(204).end();
  } catch (err) { next(err); }
});

/**
 * ── 会话模型 ──
 *
 * GET  → { model, override, default, options }
 *        model    = 这个会话实际会跑的（session-config 的覆盖，没有就是全局默认）
 *        override = 用户在这个会话里选过的；null 表示「跟随默认」
 *        options  = 可选清单，来自 model-context.js 那两张映射表旁边 ——
 *                   前端不再自己硬编码 id，写错一个字只会静默降级没人报错
 * PUT  → body { model: string | null }，null = 清掉覆盖回到默认
 *
 * 为什么单独开一条而不复用 PATCH /config：改模型不只是写字段，还得让**已经跑着的
 * query 认账**（空闲时关掉，下条消息以新模型 resume）。这两步分开过一次，结果是
 * 配置说一套、进程跑另一套。
 */
router.get('/:pid/sessions/:sid/model', async (req, res, next) => {
  try {
    validateSessionId(req.params.sid);
    const project = guardProject(req, res);
    if (!project) return;
    const { model, override, fallback } = await resolveSessionModel(
      getSessionMetaDir(req.params.pid, req.params.sid),
    );
    // default 按**项目 owner** 算（08-21；_guard.modelUserFor）：公开注册号的默认不是环境变量里的订阅行；
    // 没覆盖时按钮上显示的就是它。admin 代看 basic 项目时清单也按 owner（订阅行 locked），跟 turn.js 一致
    const modelUser = modelUserFor(req, project);
    const userDefault = defaultModelFor(modelUser) || fallback;
    res.json({ model: override || userDefault, override, default: userDefault, options: selectableModelsFor(modelUser) });
  } catch (err) { next(err); }
});

router.put('/:pid/sessions/:sid/model', async (req, res, next) => {
  try {
    validateSessionId(req.params.sid);
    const project = guardProject(req, res);
    if (!project) return;

    const raw = req.body?.model;
    if (raw !== null && typeof raw !== 'string') {
      return res.status(400).json({ error: 'model must be a string or null' });
    }
    // 只收清单里的 id：随手传个拼错的 model 进去，SDK 会自己 fallback、真实容量
    // 查不到，两处都不报错，事后只能从"怎么变慢了"倒推
    const modelUser = modelUserFor(req, project);   // 资格按项目 owner 算（_guard.js）
    if (raw !== null && isModelLockedFor(modelUser, raw)) {
      return res.status(403).json({ error: '这个模型仅限 Pro 档，暂未对外开放', code: 'MODEL_LOCKED', model: raw });
    }
    if (typeof raw === 'string' && !allowedModelsFor(modelUser).some((m) => m.id === raw)) {
      return res.status(400).json({ error: `unknown model: ${raw}`, code: 'UNKNOWN_MODEL' });
    }

    await ensureSessionWorkspace(req.params.pid, req.params.sid);
    const metaDir = getSessionMetaDir(req.params.pid, req.params.sid);
    // ⛔ 这条闸 08-25 之前是**死守卫**（08-21 装的时候就写错了位置）：它写在 applySessionModel 之后，
    // 又拿 apply **之后**读回来的 currentModel 去比 —— 那就是 raw 跟它自己比，crossLaneSwitchReason
    // 的第一行 `fromModel === toModel` 直接返回 null，一次都没拦住过；而且就算能拦，文件已经写了、
    // 空闲的 query 也已经被 applySessionModel 关掉重启了，409 只是句马后炮。
    // 现在：**apply 之前**读、拿 apply 之前的有效模型比。`raw === null`（清覆盖回默认）同样要判 ——
    // 从 Ox 会话清回订阅默认，是同一个病。
    const before = await resolveSessionModel(metaDir);
    const target = raw ?? defaultModel();
    // 只对**跑过的会话**拦：这条闸防的是历史里那些没有 signature 的 thinking 块被回传给真 Anthropic
    // （08-21 fable P3）。还没跑过的会话没有历史，拦它只会让人换不了模型。
    const why = modelSwitchRejection({
      from: before.model, to: target,
      hasHistory: await jsonlExistsForSession(getSessionWorkspace(req.params.pid, req.params.sid), req.params.sid),
    });
    if (why) return res.status(409).json({ error: why, code: 'LANE_SWITCH' });
    const result = await applySessionModel(req.params.sid, metaDir, raw, 'picker');
    const { fallback } = await resolveSessionModel(metaDir);
    res.json({
      model: result.model,
      override: result.override,
      default: fallback,
      changed: result.changed,
      restarted: result.restarted,
      options: selectableModelsFor(req.user),
    });
  } catch (err) { next(err); }
});

// ── Fork：SDK fork + 复制产物 + mv jsonl 到新 session 子目录 ──
router.post('/:pid/sessions/:sid/fork', async (req, res, next) => {
  try {
    validateSessionId(req.params.sid);
    const project = guardProject(req, res);
    if (!project) return;

    const srcSid = req.params.sid;
    const srcSessionRoot = getSessionWorkspace(req.params.pid, srcSid);
    const { upToMessageId, title } = req.body || {};

    // 标题：不传就自己拼一个（08-30）。SDK 会把源会话的标题原样复制过来，于是
    // 会话列表里两条同名，用户分不出哪条是刚分出来的。带 upToMessageId 的入口
    // （气泡上的「从这里分叉」）拿不到标题也不该为它穿三层 props，所以在这拼。
    let finalTitle = title;
    if (!finalTitle && upToMessageId) {
      const srcInfo = await withConfigDir(GLOBAL_CLAUDE_CONFIG_DIR, () =>
        getSessionInfo(srcSid, { dir: srcSessionRoot }),
      ).catch(() => null);
      const base = srcInfo?.customTitle || srcInfo?.summary || '';
      finalTitle = base ? `${base} · 分支` : '分支';
    }

    // 1. SDK fork —— 在 GLOBAL_CLAUDE_CONFIG_DIR 下生成新 sid 的 jsonl
    //
    // ⚠️ 带 upToMessageId 时**不在这里设标题**：下面第 4 步的补刀是前缀截断，而
    // forkSession 写的 custom-title 行排在最后那条用户消息之后，会被一起砍掉
    // （探针实测：9 行 fork 补刀删 3 行，标题那行在里面）。所以补完刀再设。
    const result = await withConfigDir(GLOBAL_CLAUDE_CONFIG_DIR, () =>
      forkSession(srcSid, { dir: srcSessionRoot, upToMessageId, title: upToMessageId ? undefined : finalTitle }),
    );
    const newSid = result.sessionId;
    validateSessionId(newSid);

    // 2. 备好新会话的私档目录（不再复制任何产物 —— 分叉的是对话，不是工作区）
    await forkSessionWorkspace(req.params.pid, srcSid, newSid);

    // 3. jsonl 归位。
    //
    // 扁平化之后同一个项目的所有会话共用一个 cwd，encoded 目录因此**完全相同**，
    // SDK fork 出来的 newSid.jsonl 一落地就已经在对的位置了。这一整段搬运
    // （含"换个 encoded 目录再找一遍"的兜底）只对旧数据还有意义：那时每个
    // 会话一个 cwd，fork 出来的 jsonl 落在**源会话**的目录里，不搬就找不到。
    const srcEncoded = encodeCwdForSDK(srcSessionRoot);
    const newSessionRoot = getSessionWorkspace(req.params.pid, newSid);
    const newEncoded = encodeCwdForSDK(newSessionRoot);
    if (srcEncoded !== newEncoded) {
      const srcJsonl = path.join(GLOBAL_CLAUDE_CONFIG_DIR, 'projects', srcEncoded, `${newSid}.jsonl`);
      const newJsonlDir = path.join(GLOBAL_CLAUDE_CONFIG_DIR, 'projects', newEncoded);
      const newJsonl = path.join(newJsonlDir, `${newSid}.jsonl`);
      await fs.mkdir(newJsonlDir, { recursive: true });
      try {
        await fs.rename(srcJsonl, newJsonl);
      } catch (err) {
        console.warn(`[fork] rename ${srcJsonl} → ${newJsonl} failed (${err.code}); searching alt encoded dir`);
        const altParent = path.join(GLOBAL_CLAUDE_CONFIG_DIR, 'projects');
        const pidPrefix = encodeCwdForSDK(getProjectWorkspace(req.params.pid));
        const altSubs = (await fs.readdir(altParent).catch(() => []))
          .filter(sub => sub.startsWith(pidPrefix));
        for (const sub of altSubs) {
          const candidate = path.join(altParent, sub, `${newSid}.jsonl`);
          try {
            await fs.access(candidate);
            await fs.rename(candidate, newJsonl);
            break;
          } catch { /* continue */ }
        }
      }
    }

    // 4. 「到这条为止」在我们这儿是**不含**那条（08-30）。
    //
    // SDK 的 upToMessageId 是含的（探针实测），而这个接口的调用方是「从这条消息
    // 分叉」—— 用户点的是自己那句想重说的话，含着它 fork 出来等于什么都没改。
    // uuid 被 fork 重映射过，拿原 id 截不到，所以按"最后一条真用户消息"下刀。
    // 不传 upToMessageId 的整条 fork（会话列表那个入口）不受影响。
    if (upToMessageId) {
      await truncateJsonlAtLastUserMessage(newSessionRoot, newSid);
      // 标题在补刀之后才落得住（见上）。设不上不算失败 —— 分支本身已经好了，
      // 列表里退回摘要显示而已。
      if (finalTitle) {
        await withConfigDir(GLOBAL_CLAUDE_CONFIG_DIR, () =>
          renameSession(newSid, finalTitle, { dir: newSessionRoot }),
        ).catch((err) => console.warn(`[fork] 设分支标题失败：${err.message}`));
      }
    }

    res.json({ sessionId: newSid });
  } catch (err) { next(err); }
});

// ── PATCH：rename / tag ──
router.patch('/:pid/sessions/:sid', async (req, res, next) => {
  try {
    validateSessionId(req.params.sid);
    const project = guardProject(req, res);
    if (!project) return;

    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);
    const { title, tag } = req.body || {};

    if (typeof title === 'string') {
      if (title.length > 200) return res.status(400).json({ error: 'title too long (max 200)' });
      await withConfigDir(GLOBAL_CLAUDE_CONFIG_DIR, () =>
        renameSession(req.params.sid, title, { dir: sessionRoot }),
      );
    }
    if ('tag' in (req.body || {})) {
      if (tag !== null && typeof tag !== 'string') {
        return res.status(400).json({ error: 'tag must be string or null' });
      }
      if (typeof tag === 'string' && tag.length > 50) {
        return res.status(400).json({ error: 'tag too long (max 50)' });
      }
      await withConfigDir(GLOBAL_CLAUDE_CONFIG_DIR, () =>
        tagSession(req.params.sid, tag, { dir: sessionRoot }),
      );
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Close：终结活跃 query session（streamInput 模式）──
//   POST /api/projects/:pid/sessions/:sid/close
//   关掉 inputQueue → runSession for-await-of 自然退出 → query 进程死。
//   下次 turn 该 sid 起新 runSession（resume 旧 jsonl）。
//   200 { ok: true, wasActive }
router.post('/:pid/sessions/:sid/close', async (req, res, next) => {
  try {
    validateSessionId(req.params.sid);
    const project = guardProject(req, res);
    if (!project) return;
    const wasActive = hasActiveQuerySession(req.params.sid);
    if (wasActive) closeQuerySession(req.params.sid, 'user_close');
    res.json({ ok: true, wasActive });
  } catch (err) { next(err); }
});

// ── DELETE：SDK 删 jsonl + rm session 目录（产物 / git） ──
router.delete('/:pid/sessions/:sid', async (req, res, next) => {
  try {
    validateSessionId(req.params.sid);
    const project = guardProject(req, res);
    if (!project) return;

    const sessionRoot = getSessionWorkspace(req.params.pid, req.params.sid);

    // 1. SDK delete jsonl（从全局 CLAUDE_CONFIG_DIR 删除）
    try {
      await withConfigDir(GLOBAL_CLAUDE_CONFIG_DIR, () =>
        deleteSession(req.params.sid, { dir: sessionRoot }),
      );
    } catch (err) {
      // 如果 jsonl 已经不存在或 SDK 找不到，silent skip — 后面 rm 整个目录兜底
      console.warn(`[delete session] SDK delete failed (${err.message}); proceeding to rm dir`);
    }

    // 2. 删这条会话的私档（`.nd/<sid>/`）。
    //
    // ⚠️ 这里以前是 `rm -rf sessions/<sid>/`（产物 + git + 软链），后面还跟着
    // 一步"连带删掉绑定的任务文件夹"。**删对话现在绝不能碰产物** —— 产物属于
    // 项目，同一个项目里换条对话继续做是常态。
    await removeSessionWorkspace(req.params.pid, req.params.sid);

    // 3. 清 active_session_id 如果指向被删的。**要广播** —— 指针是会话真相源
    //    （2026-08-13 收敛），别的标签页不知道指针被清就会继续往死会话里发。
    //    为什么这条事件不带 sessionId 字段：见 events.js projectActiveSession 注释。
    if (project.activeSessionId === req.params.sid) {
      try {
        setActiveSession(req.params.pid, null);
        getProjectBus(req.params.pid).publish(Events.projectActiveSession(null));
      } catch { /* ignore */ }
    }

    res.status(204).end();
  } catch (err) { next(err); }
});


export default router;
