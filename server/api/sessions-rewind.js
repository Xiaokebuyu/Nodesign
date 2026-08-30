/**
 * server/api/sessions-rewind.js — 「回到某条消息之前」（2026-08-30 从 sessions.js
 * 拆出，行数棘轮）。
 *
 * 它自成一件事：两个正交开关（回不回文件 / 截不截对话）× 三条执行路径（不碰 SDK /
 * 用活口 query / 起临时 query），加上 jsonl 截断那套原子写。放回 sessions.js 会让
 * 那个文件一半篇幅在讲回滚。
 *
 * `pendingRewinds` 也跟着搬过来 —— 它是这套流程的互斥牌，turn.js 拿它拒同 sid 新
 * turn（防两个 SDK subprocess 同时写一份 jsonl，或 turn 写进正要被砍掉的那段尾巴）。
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { guardProject } from './_guard.js';
import { closeQuerySession, hasActiveQuerySession, getQuerySession } from '../engine/runs/active-runs.js';
import { getSessionWorkspace, validateSessionId } from '../projects/workspace.js';
import { jsonlExistsForSession, truncateJsonlAtMessage } from '../projects/session-jsonl.js';
import { AsyncQueue } from '../lib/async-queue.js';
import { getProjectBus } from '../ws/broker.js';
import { platform } from '../runtime/platform.js';

const GLOBAL_CLAUDE_CONFIG_DIR = platform.claudeConfigDir;

/**
 * 进行中的 rewind 操作 sid 集合 —— 供 turn.js startNewRunSession 守卫使用，
 * 防止同 sid 临时 rewind query 跟 normal turn query 同时启动撞 jsonl。
 */
export const pendingRewinds = new Set();

/** 把 rewind 路由挂到 sessions 的 router 上（sessions.js 调一次）。 */
export function mountRewindRoute(router) {
  // ── POST /:pid/sessions/:sid/rewind ──
  // 回到某条用户消息之前。**两件事，两个开关，互相正交**（2026-08-30 拆开）：
  //
  //   files=true           产物回退：SDK Query.rewindFiles(userMessageId) 把工作区文件
  //                        回滚到该消息之前（后续 Edit/Write 全撤销）。SDK file
  //                        checkpoint 写在 session jsonl（type='file-history-snapshot'），
  //                        跨进程持久化天然搞定。
  //   truncateConversation 对话回退：把 jsonl 截到该消息之前。显示与模型记忆读的都是
  //   =true                这份 jsonl，所以截了记忆才真的回退。
  //
  // 以前这两件绑死一起做。拆开是因为它们是两种不同的后悔：「这句话我说错了，重说」
  // 只该动对话；「它照我说的做出来的东西我不要了」才该动文件。默认值仍是两个都 true
  // ——「回到此处」的老行为一字不改。
  //
  // ⚠️ 产物只有一份（一个项目一个工作区），所以 files=true 是**项目级**的影响：
  // 同项目其他会话看到的也是回退后的文件。调用方要在 UI 上把这件事说明白。
  //
  // 三条路径：
  //   0. files=false → 压根不需要 SDK（关活口 query + 截 jsonl 即可），瞬间完成
  //   1. active query 在跑 → 直接用现有 query.rewindFiles（最快，无 spawn 成本）
  //   2. session 已 close（历史 session）→ 起临时 query (resume + drain) → rewindFiles → close
  //
  // 历史 session 也能 undo —— 之前返 410 是应用层偷懒，SDK 完全支持 resume + rewindFiles。
  //
  // body: { userMessageId, files?=true, truncateConversation?=true }
  // 200 { canRewind, filesChanged?, insertions?, deletions?, conversationTruncated, removedEntries }
  // 400 两个开关都 false（没让它做任何事）
  // 404 { code: 'JSONL_MISSING' }   jsonl 不存在（session 删了 / 部分创建）
  // 409 { code: 'REWIND_BUSY' }     同 sid 已有 rewind 进行中
  // 500 { code: 'REWIND_FAILED' }   临时 query 启动 / rewindFiles 失败
  router.post('/:pid/sessions/:sid/rewind', async (req, res, next) => {
    try {
      validateSessionId(req.params.sid);
      const project = guardProject(req, res);
      if (!project) return;

      const { userMessageId, files = true, truncateConversation = true } = req.body || {};
      if (!userMessageId || typeof userMessageId !== 'string') {
        return res.status(400).json({ error: 'userMessageId required' });
      }
      const wantFiles = files !== false;
      const wantTruncate = truncateConversation !== false;
      if (!wantFiles && !wantTruncate) {
        return res.status(400).json({ error: 'nothing to do: files and truncateConversation both false' });
      }

      const { pid, sid } = req.params;

      // ── 路径 0：只回对话 ──
      // 不碰 SDK 就够了：关掉活口 query（下条消息从截断后的 jsonl resume，记忆才真的
      // 回退），等它 flush 完把 jsonl 截了。省掉临时 query 那 3-5 秒的 spawn。
      if (!wantFiles) {
        const sessionRoot = getSessionWorkspace(pid, sid);
        if (!await jsonlExistsForSession(sessionRoot, sid)) {
          return res.status(404).json({ error: 'session jsonl not found', code: 'JSONL_MISSING' });
        }
        if (pendingRewinds.has(sid)) {
          return res.status(409).json({ error: 'rewind in progress', code: 'REWIND_BUSY' });
        }
        // 挂牌同 SDK 路径：turn.js 见 pendingRewinds 有这个 sid 就拒新 turn。这条路
        // 虽然不起临时 query，但它**写** jsonl —— 截断中途来一条 turn 会写进正要被
        // 砍掉的那段尾巴上。
        pendingRewinds.add(sid);
        try {
          if (hasActiveQuerySession(sid)) {
            try { closeQuerySession(sid, 'rewind_truncate'); } catch { /* */ }
            await new Promise((r) => setTimeout(r, 800));
          }
          const removed = await truncateJsonlAtMessage(sessionRoot, sid, userMessageId);
          const payload = { canRewind: removed != null, filesChanged: [], conversationTruncated: removed != null, removedEntries: removed ?? 0 };
          emitRewindFiles(pid, sid, payload);
          return res.json(payload);
        } finally {
          pendingRewinds.delete(sid);
        }
      }

      // 路径 1：active query 在跑 —— 直接用现有 query
      const rec = getQuerySession(sid);
      if (rec?.query && !rec.abortController.signal.aborted) {
        const result = await rec.query.rewindFiles(userMessageId);
        // 对话层同步回滚（2026-08-08「做完整」）：rewindFiles 只回文件。显示与模型
        // 记忆读的都是这份 jsonl —— 关掉活口 query（下条消息从截断后的 jsonl resume，
        // 记忆才真的回退），等 SDK flush 后把 jsonl 截到该 user 消息之前。
        // truncateConversation=false（fork 带产物回退那条路）时整段跳过：源会话的
        // 对话要原样留着，动的只有磁盘。query 也不关 —— 不截 jsonl 就没有"让它重读"的必要。
        let removed = null;
        if (wantTruncate) {
          try { closeQuerySession(sid, 'rewind_truncate'); } catch { /* */ }
          await new Promise((r) => setTimeout(r, 800));
          removed = await truncateJsonlAtMessage(getSessionWorkspace(pid, sid), sid, userMessageId);
        }
        const payload = { ...result, conversationTruncated: removed != null, removedEntries: removed ?? 0 };
        emitRewindFiles(pid, sid, payload);
        return res.json(payload);
      }

      // race guard：active session 存在但 query handle 未 attach（session 启动中
      // 的窄 race window — registerQuerySession 已 set Map 但 attachSessionQuery
      // 还没赋值 query 字段）→ 拒 409 让用户重试。如果直接 fallthrough 进路径 2
      // 起临时 query，两个 SDK binary 会同时 attach 同一 jsonl 文件 → 错乱不可恢复。
      if (hasActiveQuerySession(sid) && rec && !rec.abortController.signal.aborted) {
        return res.status(409).json({
          error: 'session is starting (query handle not yet attached), retry shortly',
          code: 'SESSION_STARTING',
        });
      }

      // 路径 2：起临时 query resume → rewindFiles → close
      if (pendingRewinds.has(sid)) {
        return res.status(409).json({ error: 'rewind in progress', code: 'REWIND_BUSY' });
      }
      const sessionRoot = getSessionWorkspace(pid, sid);
      if (!await jsonlExistsForSession(sessionRoot, sid)) {
        return res.status(404).json({ error: 'session jsonl not found', code: 'JSONL_MISSING' });
      }

      pendingRewinds.add(sid);
      const inputQueue = new AsyncQueue();
      let tempQuery = null;
      let drain = null;
      try {
        tempQuery = query({
          prompt: inputQueue,
          options: {
            resume: sid,
            enableFileCheckpointing: true,
            cwd: sessionRoot,
            // 关键：跟 runSession 一致传 CLAUDE_CONFIG_DIR，否则 SDK 找不到 jsonl
            env: { ...process.env, CLAUDE_CONFIG_DIR: GLOBAL_CLAUDE_CONFIG_DIR },
            persistSession: true,
            // 不传 hooks / mcpServers / agents / canUseTool —— 临时 query 不跑 turn
          },
        });
        // fire-and-forget consume —— SDK control method 走 bidirectional protocol，
        // stream 不消费会卡死 control RPC。drain 跑在后台，close 后自然结束。
        drain = (async () => {
          try { for await (const _ of tempQuery) { /* discard */ } }
          catch { /* expected on close */ }
        })();
        // 15s timeout（SDK boot + jsonl load + control RPC ~3-5s 正常 → 3× margin）
        const result = await Promise.race([
          tempQuery.rewindFiles(userMessageId),
          new Promise((_, rj) => setTimeout(() => rj(new Error('rewind timeout')), 15000)),
        ]);
        // 对话层回滚：先收干净临时 query（文件句柄/尾部 flush），再截断 jsonl
        try { tempQuery.close(); } catch { /* */ }
        try { inputQueue.close(); } catch { /* */ }
        if (drain) { try { await drain; } catch { /* */ } }
        tempQuery = null; drain = null;
        let removed = null;
        if (wantTruncate) {
          await new Promise((r) => setTimeout(r, 300));
          removed = await truncateJsonlAtMessage(sessionRoot, sid, userMessageId);
        }
        const payload = { ...result, conversationTruncated: removed != null, removedEntries: removed ?? 0 };
        emitRewindFiles(pid, sid, payload);
        res.json(payload);
      } catch (err) {
        console.warn(`[sessions.rewind] temp query failed (sid=${sid.slice(0, 8)}): ${err.message}`);
        res.status(500).json({ error: err.message, code: 'REWIND_FAILED' });
      } finally {
        try { tempQuery?.close(); } catch { /* ignore */ }
        try { inputQueue.close(); } catch { /* ignore */ }
        if (drain) { try { await drain; } catch { /* ignore */ } }
        pendingRewinds.delete(sid);
      }
    } catch (err) { next(err); }
  });
}

/**
 * rewindFiles 成功后 emit run.file_changed 事件让前端 iframe 自动 reload。
 * 复用现有 event 类型 —— ProjectWorkspace.jsx 已 case 它（仅 .html 后缀 bump reloadToken），
 * 0 前端事件代码改动。
 */
function emitRewindFiles(pid, sid, result) {
  if (!result?.canRewind || !Array.isArray(result.filesChanged) || !result.filesChanged.length) return;
  const bus = getProjectBus(pid);
  for (const filePath of result.filesChanged) {
    bus.publish({
      type: 'run.file_changed',
      filePath,
      event: 'change',
      sessionId: sid,
      ts: new Date().toISOString(),
    });
  }
}
