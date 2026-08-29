/**
 * server/ws/index.js — WebSocket 升级入口
 *
 * URL 模式：/ws/projects/:pid
 *
 * 流程：
 *   1. http server 'upgrade' 事件触发
 *   2. parse URL 取 pid
 *   3. validateProjectId + getProject 校验存在
 *   4. wss.handleUpgrade → 拿到 ws 对象
 *   5. 订阅该 project 的 EventBus，事件 JSON.stringify 推 ws.send
 *   6. ping/pong 30s 心跳
 *   7. ws close → unsubscribe + clearInterval
 */

import { WebSocketServer } from 'ws';
import { createBrowseWS } from './browse-channel.js';
import { URL } from 'url';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { validateProjectId, getProject } from '../projects/store.js';
import { getSessionWorkspace, validateSessionId } from '../projects/workspace.js';
import { withConfigDir } from '../lib/sdk-session.js';
import { platform } from '../runtime/platform.js';
import { getProjectBus } from './broker.js';
import { requestUser } from '../auth/session.js';
import { originAllowed } from '../auth/origin-guard.js';
import { userOwnsProject } from '../api/_guard.js';
import {
  getCurrentTurnRunId,
  hasActiveQuerySession,
  closeQuerySession,
  markSessionActivity,
} from '../engine/runs/active-runs.js';
import { workingSubagents } from '../engine/agent/subagent-flight.js';
import { getLiveTurnSnapshot } from '../engine/runs/live-turn.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const HYDRATE_CHUNK_SIZE = 50;
const GLOBAL_CLAUDE_CONFIG_DIR = platform.claudeConfigDir;

/**
 * WS 全部断开后再 N ms 仍无重连 → closeQuerySession 让 SDK subprocess 退出，
 * 防止用户关 tab / 刷新后服务器孤儿 SDK process 永久占内存（每个 ~250MB RSS）。
 *
 * 默认 60s 给前端 ws-client.js exponential backoff（1s→2s→...→30s）足够重连窗口。
 * env NODESIGN_WS_GRACE_MS 可调（生产可拉到 5min 给移动端弱网）。
 */
const WS_GRACE_MS = Number(process.env.NODESIGN_WS_GRACE_MS) || 60_000;

/**
 * 后台角色在飞时最多续多少个 grace 周期（默认 10 × 60s = 10 分钟）。
 *
 * 封顶不是性能优化，是**这道闸自己的保险**：SubagentStop 漏一次（hook 抛异常、
 * SDK 换版本改字段名、进程被 kill -9），在飞台账里就永远躺着一个不落地的条目，
 * 会话再也关不掉 —— 一个 SDK 进程 ~250MB 且 RSS 单调不减，这台盒子 swap=0。
 * 封到期照常关，日志喊一声，最坏后果回到「腰斩」这个原状，不会更差。
 *
 * 上限按实测选：turn 中位 57s，角色写一拍 700 字实测 ~2.5min，10 分钟够宽。
 */
const MAX_SUBAGENT_DEFERS = Number(process.env.NODESIGN_WS_SUBAGENT_DEFER_MAX) || 10;

/**
 * sid → { count: 当前活跃 WS 连接数, graceTimer: 0 引用时启动的关闭定时器 }
 *
 * 每条带 sid 的 WS 连接 ref++，close 时 ref--；归零启 grace timer，N ms 内有新 WS
 * 进同 sid 立即清 timer 续命；timer 到期再确认 0 ref 后 closeQuerySession。
 *
 * /work 路径（无 sid）的 WS 不进 sessionRefs（无 session 可绑）。
 */
const sessionRefs = new Map();

function refSession(sid, projectId = null) {
  if (!sid) return;
  let entry = sessionRefs.get(sid);
  if (!entry) {
    entry = { count: 0, graceTimer: null, projectId, subagentDefers: 0 };
    sessionRefs.set(sid, entry);
  }
  if (projectId) entry.projectId = projectId;   // 事件与状态按项目分桶
  entry.subagentDefers = 0;                     // 人回来了，续命额度重新计
  entry.count += 1;
  if (entry.graceTimer) {
    clearTimeout(entry.graceTimer);
    entry.graceTimer = null;
  }
  // WS 连上算一次活跃信号（idle scan 不会立即把刚连的 session 当僵尸关掉）
  markSessionActivity(sid);
}

function unrefSession(sid) {
  if (!sid) return;
  const entry = sessionRefs.get(sid);
  if (!entry) return;
  entry.count = Math.max(0, entry.count - 1);
  if (entry.count > 0) return;
  // 0 ref → 启 grace timer。若 grace 期内有新 WS 进同 sid，refSession 会清掉 timer
  if (entry.graceTimer) clearTimeout(entry.graceTimer);
  const onGraceExpired = () => {
    const cur = sessionRefs.get(sid);
    if (!cur || cur.count > 0) return;  // 期间有新连上，不关
    // 进行中的 turn 不杀（2026-07-27）：用户关 tab / 切走时后端应该把活干完，
    // 前端重连后靠 hydrate + live_turn 快照接回状态。这正是"前端丢失后端工作
    // 状态"要保住的那半 —— 老逻辑 60s 就 cancel 在跑的 turn，是真丢工作。
    // 续一个 grace 周期再查；turn 结束后仍无订阅者才真正关（idle SDK 进程回收）。
    if (getCurrentTurnRunId(sid)) {
      console.info(`[ws] grace expired for sid=${sid.slice(0, 8)} but turn in flight — deferring close`);
      cur.graceTimer = setTimeout(onGraceExpired, WS_GRACE_MS);
      cur.graceTimer.unref?.();
      return;
    }
    // 后台角色在写也不杀（2026-08-28）：主持人的一拍几秒钟就结束，角色还要写好几分钟
    // —— 上面那道闸只认 turn，认不出这种在飞工作。08-28 实录：角色派出 110s 后 grace
    // 到期，人被腰斩在第三个 Read 上，板上永远没有第二段。
    // （08-29：判据从「在飞 − 候场」简化成「在飞」—— 角色写完就结束这一轮，
    //  没有挂着不收回合的形态了。见 subagent-flight.js 头注。）
    const working = workingSubagents(sid, cur.projectId);
    if (working.length > 0) {
      if (cur.subagentDefers < MAX_SUBAGENT_DEFERS) {
        cur.subagentDefers += 1;
        const who = working.map((w) => w.name || w.agentType || w.agentId.slice(0, 8)).join(', ');
        console.info(
          `[ws] grace expired for sid=${sid.slice(0, 8)} but ${working.length} subagent(s) still working `
          + `[${who}] — deferring close (${cur.subagentDefers}/${MAX_SUBAGENT_DEFERS})`,
        );
        cur.graceTimer = setTimeout(onGraceExpired, WS_GRACE_MS);
        cur.graceTimer.unref?.();
        return;
      }
      // 封顶：台账没落地不代表人还活着，不能拿它无限抵押一个 250MB 的进程
      console.warn(
        `[ws] sid=${sid.slice(0, 8)} 续命已封顶（${MAX_SUBAGENT_DEFERS} × ${WS_GRACE_MS}ms），`
        + `台账里仍有 ${working.length} 个子代理在飞 —— 照常关闭回收，它们没写完的活会丢。`
        + `若这条常出现，先查 SubagentStop 是不是漏了盖章（在飞台账只进不出）。`,
      );
    }
    sessionRefs.delete(sid);
    if (hasActiveQuerySession(sid)) {
      console.info(`[ws] grace expired for sid=${sid.slice(0, 8)}, closing session (no_active_subscriber)`);
      closeQuerySession(sid, 'no_active_subscriber');
    }
  };
  entry.graceTimer = setTimeout(onGraceExpired, WS_GRACE_MS);
  entry.graceTimer.unref?.();
}

export function setupWS(httpServer) {
  // 浏览器画面/输入的专用通道（2026-08-18），独立 WebSocketServer
  const browseWS = createBrowseWS();
  // perMessageDeflate：弱网下 hydrate chunk + ring-buffer replay 帧成本是 raw size
  // 量级（>2MB session 一次首屏 hydrate 估 250KB+ raw）。permessage-deflate 让
  // JSON 文本压到 5-10x。threshold 1KB 跳过小帧（控制帧无收益反增 CPU）。
  // env NODESIGN_WS_DISABLE_DEFLATE=1 应急关闭（CPU 紧的部署环境）。
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: process.env.NODESIGN_WS_DISABLE_DEFLATE === '1'
      ? false
      : { threshold: 1024 },
  });

  httpServer.on('upgrade', (req, socket, head) => {
    // ⛔ CSRF 闸（2026-08-18）：cookie 是 SameSite=Lax，而已发布站点与应用主机
    // 同 eTLD+1 = 同站，Lax 照发（真跑验过，见 auth/origin-guard.js 文件头）。
    // 这里**不学下面那个 4401 的握手后再关**：那套是为了让我们自己的前端看得见
    // 原因好停止重连；外站页面不需要体面的错误，403 直接掐在升级前最省。
    if (!originAllowed(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }

    // 登录墙（2026-07-30 多用户）：解析身份而非布尔。cookie 无效不再写 HTTP 401
    // 拒 upgrade —— 浏览器拿不到 upgrade 阶段的状态码，只见 close 1006，前端
    // ws-client 会无限指数退避重连。改为完成握手后 close(4401)，前端把它列为
    // fatal code → 停止重连并回登录页。
    const user = requestUser(req);

    let url;
    try {
      url = new URL(req.url || '/', 'http://x');
    } catch {
      return socket.destroy();
    }

    // ⚠️ 浏览器画面通道的分支**必须排在下面那个 404 之前** —— 那句 404 是兜底，
    // 不匹配 `/ws/projects/:pid` 的路径会被它直接毙掉。
    // 为什么另开一条而不是复用这条：这条是纯下行 + EventBus 广播 + 2000 条重放
    // 缓冲，高频画面帧灌进去会冲爆重放缓冲、混进 hydrate 回放，而且 JSON+base64
    // 帧会被 perMessageDeflate 白压一遍。详见 ws/browse-channel.js 文件头。
    {
      const bm = browseWS.matches(url.pathname);
      if (bm) return browseWS.accept(req, socket, head, bm);
    }

    const m = url.pathname.match(/^\/ws\/projects\/([^/]+)$/);
    if (!m) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      return socket.destroy();
    }

    const pid = decodeURIComponent(m[1]);
    try {
      validateProjectId(pid);
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      return socket.destroy();
    }

    // 身份或归属不对 → 握手后 4401 关闭（同一个 code：外人不该分得清
    // "没登录"和"不是你的项目"）
    const project = getProject(pid);
    if (!user || !userOwnsProject(user, project)) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(4401, 'unauthorized');
      });
      return;
    }

    // ?since=N — 客户端最后看到的 EventBus seq；server 通过 buffer 回放 (since, _seq] 段
    // 第一次连不带 since → since=0 → 不 replay 直接 live。
    const sinceRaw = url.searchParams.get('since');
    const since = sinceRaw != null ? Math.max(0, parseInt(sinceRaw, 10) || 0) : 0;

    // Phase A.4：?sid=<sessionId> — 客户端当前在哪个 session 上，server 在 first connect /
    // gap 时推 ws.hydrate.* 帧补完整 messages。无 sid 时（/work 路径）跳过 hydrate
    // 直接 replay+live。
    let sid = url.searchParams.get('sid');
    if (sid) {
      try { validateSessionId(sid); }
      catch { sid = null; }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleProjectWS(ws, pid, since, sid);
    });
  });

  return wss;
}

/**
 * 读 jsonl 历史（异步，几百 ms）。发帧是另一个纯同步函数 —— 读完到发出之间不能
 * 再有 await，否则"读到的历史"与"当时的 live turn 快照"会错位（见 handleProjectWS）。
 */
async function loadHydrate(pid, sid) {
  const sessionRoot = getSessionWorkspace(pid, sid);
  return withConfigDir(GLOBAL_CLAUDE_CONFIG_DIR, () =>
    getSessionMessages(sid, { dir: sessionRoot, includeSystemMessages: false }),
  );
}

/**
 * 本轮由快照权威：jsonl 里属于当前 turn 的 assistant 条目全部裁掉。
 *
 * SDK 按 block 逐条写 jsonl（thinking / text / tool_use 各一行），一个 turn 跑到
 * 一半时前面几条已经落盘 —— 那些内容同时也在 live_turn 快照里（快照从 run.start
 * 折叠整轮）。两边 id 体系不同（jsonl 是 `<uuid>:text:<n>`，快照是 `<runId>:mN`），
 * 前端去不了重，正文就渲染两遍。这是用户报的"重复传"的根因，100% 复现。
 *
 * 只裁 assistant：user 条目（用户自己那句话）快照里没有，裁了就真丢了。掉队的
 * tool_result 会因为找不到对应 tool_use 被 sessionMessagesToDisplay 自然跳过。
 */
function dropInFlightTurn(messages, startedAt) {
  if (!startedAt) return messages;
  const cut = Date.parse(startedAt);
  if (Number.isNaN(cut)) return messages;
  return messages.filter(m => !(
    m?.type === 'assistant' && m.timestamp && Date.parse(m.timestamp) >= cut
  ));
}

/**
 * Phase A.4：推 ws.hydrate.start/chunk/end 帧把 jsonl 历史 messages 同步给前端。
 * 必须在 subscribeFromSeq 之前发，确保前端先 hydrate 后 apply replay/live events。
 * 纯同步。
 */
function sendHydrateFrames(ws, sid, messages, asOfSeq) {
  if (ws.readyState !== ws.OPEN) return;
  const total = messages.length;
  ws.send(JSON.stringify({
    type: 'ws.hydrate.start',
    sessionId: sid,
    total,
    asOfSeq,
    ts: new Date().toISOString(),
  }));
  for (let i = 0; i < total; i += HYDRATE_CHUNK_SIZE) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({
      type: 'ws.hydrate.chunk',
      sessionId: sid,
      chunkIdx: Math.floor(i / HYDRATE_CHUNK_SIZE),
      messages: messages.slice(i, i + HYDRATE_CHUNK_SIZE),
    }));
  }
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type: 'ws.hydrate.end', sessionId: sid, total }));
}

/** hydrate 读失败 fail-soft：前端收到后兜底走 HTTP Sessions.read */
function sendHydrateError(ws, sid, message) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify({
      type: 'ws.hydrate.start', sessionId: sid, kind: 'error', error: message,
    }));
  } catch { /* ignore */ }
}

async function handleProjectWS(ws, pid, since = 0, sid = null) {
  const bus = getProjectBus(pid);

  // 诊断 log：用户重启服务器后报"前端收不到事件"——这条 log 让 pm2 logs 一眼看出
  // WS 是不是真连上 + 客户端传的 sid 跟 server 端 active session 状态对不对。
  console.info(
    `[ws] connect pid=${pid} sid=${sid ? sid.slice(0, 8) : 'none'} `
    + `hasActiveSession=${sid ? hasActiveQuerySession(sid) : 'n/a'} since=${since}`,
  );

  // sid lifecycle ref：带 sid 的 WS 连上即 ref++，close/error 时 unref。0 ref 触发
  // grace timer N ms 后 closeQuerySession 让 SDK subprocess 自然退出。
  refSession(sid, pid);

  // ── 连接协议（2026-07-27 重构：快照 + 尾随，每次连接都全量重建）──
  //
  //   ① jsonl hydrate     — 已完成 turn 的历史（turn 边界 flush 的持久层）
  //   ② ws.live_turn 快照 — 进行中 turn 的物化重建（live-turn.js 同步折叠，
  //                          覆盖"刷新 / 断线期间错过的全部流式内容"）
  //   ③ 尾随订阅          — 从快照 seq 起 replay ring buffer + 切 live
  //
  // 老协议的 ?since= 游标 + gap 补 hydrate 废弃：ring buffer(2000) 对 token 级
  // streaming 几秒断线就 gap，gap 后 hydrate 帧晚于 replay/live 到达，前端
  // hydrate.end 整体替换 messages 把刚渲染的内容洗掉。新协议 hydrate 永远先发，
  // 快照覆盖 ring 之外的一切，ring 只需覆盖"读 jsonl 的几百 ms"同步窗口。
  // `since` 参数保留解析但忽略（旧前端兼容）。
  //
  // 两份历史的边界（2026-07-28）：jsonl 与快照对"进行中的 turn"是重叠的 ——
  // 读 jsonl 与取快照必须在**同一个同步区**里完成并一起发出，中间不能 await，
  // 否则 turn 在缝里结束会让两边错位。规则：本轮由快照权威，hydrate 裁掉本轮。
  const seqAtHydrateStart = bus._seq || 0;
  let loaded = null;
  let loadErr = null;
  const t0 = Date.now();
  if (sid) {
    try { loaded = await loadHydrate(pid, sid); }
    catch (err) { loadErr = err; }
  }

  // ↓↓↓ 同步区开始（不要在这里插 await）↓↓↓
  const snapshot = sid ? getLiveTurnSnapshot(sid) : null;
  if (sid) {
    if (loadErr) {
      console.warn(`[ws] hydrate failed for ${pid}/${sid}:`, loadErr.message);
      sendHydrateError(ws, sid, loadErr.message);
    } else {
      const trimmed = snapshot ? dropInFlightTurn(loaded, snapshot.startedAt) : loaded;
      console.info(
        `[ws] hydrate sid=${sid.slice(0, 8)} loaded ${loaded.length} messages in ${Date.now() - t0}ms`
        + (snapshot ? ` (本轮 ${loaded.length - trimmed.length} 条交给快照)` : ''),
      );
      sendHydrateFrames(ws, sid, trimmed, seqAtHydrateStart);
    }
  }
  if (snapshot && ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'ws.live_turn', sessionId: sid, ...snapshot }));
    } catch (err) {
      console.warn(`[ws] live_turn send failed for ${pid}:`, err.message);
    }
  }
  // ↑↑↑ 同步区结束 ↑↑↑

  // sid 过滤：projectBuses per-project 共享，只推本 session 事件 + 无 sessionId
  // 的全局事件。sid=null（/work 路径）时 session-scoped 事件全部不推 ——
  // 老行为"收全部"会把别的 session 的 delta 渲进空 chat（串台）；/work 没有
  // session，本来就不该收 run 流，新建 session 后前端会带 sid 重连。
  const subscribeSince = snapshot ? snapshot.seq : seqAtHydrateStart;
  const { unsubscribe, replayed, gap } = bus.subscribeFromSeq(subscribeSince, (event) => {
    if (event.sessionId && event.sessionId !== sid) return;
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(event));
      } catch (err) {
        console.warn(`[ws] send failed for ${pid}:`, err.message);
      }
    }
  });

  const heartbeat = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      try { ws.ping(); } catch { /* will close */ }
    }
  }, HEARTBEAT_INTERVAL_MS);

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeat);
    unsubscribe();
    unrefSession(sid);
  };

  ws.on('close', cleanup);
  ws.on('error', (err) => {
    console.warn(`[ws] error for ${pid}:`, err.message);
    cleanup();
  });

  // 确认 + replay 元信息（gap=true 客户端可决定全量 hydrate）。
  // 故意放在 replay 之后发：客户端看到 ws.connected 就知道 backlog 已 drain，可切回正常 live 状态。
  //
  // activeRunId：sid 上当前在跑的 turn runId（无则 null）。前端用它重连后恢复
  // isStreaming/currentRunId —— 否则 WS 抖动期间 run.start 已发完且 buffer 没新事件
  // 时，前端永远不知道 run 还活着（stop 按钮消失，UX 表现"流没了"）。
  const activeRunId = sid ? getCurrentTurnRunId(sid) : null;
  try {
    ws.send(JSON.stringify({
      type: 'ws.connected',
      projectId: pid,
      ts: new Date().toISOString(),
      since,
      replayed,
      gap,
      activeRunId,
    }));
  } catch { /* immediate close edge */ }
}
