/**
 * server/engine/runs/live-turn.js — 进行中 turn 的物化快照（内存态）
 *
 * 解决的问题：EventBus 是 fire-and-forget + ring buffer（2000 条），token 级
 * streaming 一个 turn 就上万条事件 —— 刷新 / 断线重连后"进行中的 turn"在任何
 * 可恢复的地方都不存在（jsonl 只在 turn 边界 flush）。老架构靠 ?since= 游标 +
 * ring 回放，重连几秒就 gap，gap 补 hydrate 又把已渲染内容反向覆盖。
 *
 * 新范式（快照 + 尾随，2026-07-27 重构）：
 *   - 本模块订阅每个 project bus，把进行中 turn 的事件**同步折叠**成前端
 *     display-message 形态的物化状态（跟 ProjectWorkspace handleEvent 的累加
 *     逻辑同构）
 *   - WS 连接时：jsonl hydrate（已完成 turn）→ ws.live_turn 快照（进行中 turn）
 *     → 从快照 seq 起订阅实时流。ring buffer 大小从此只影响极小的同步窗口，
 *     不再影响正确性
 *   - turn 结束（done / error / cancelled）或 session 结束即清，内存占用 =
 *     活跃 turn 数 × 单 turn 消息体量（tool output 截断到 16k）
 *
 * 折叠规则跟前端 handleEvent 对齐（改前端渲染逻辑时两边同步改）：
 *   run.delta.text / thinking       → 同 role 连续累加一条消息
 *   run.tool_use.started            → push tool 消息 status='running'
 *   run.delta.tool_use              → 补 toolInput
 *   run.delta.tool_result           → 补 status / output / error（images 不进快照，太大）
 *   run.context_usage               → contextUsage 覆盖
 *   run.done / error / cancelled    → 标记 ended（保留 GRACE 毫秒，见下），不再折叠
 *   run.query.end                   → 清
 *
 * turn 结束后为什么还留一小会（2026-07-28）：jsonl 是 SDK 子进程按 block 逐条写的，
 * 我们读 jsonl 与 turn 收尾之间有几百毫秒的错位窗口。这段时间内重连，若快照已经
 * 没了，尾随订阅会把已经落进 jsonl 的那几条 delta 再放一遍 → 正文重复。留 GRACE
 * 毫秒让"本轮由快照权威、hydrate 裁掉本轮"这条规则在收尾瞬间同样成立。
 */

const MAX_TOOL_TEXT = 16_000;
// 3s：够盖住"读 jsonl 的几百毫秒"这个错位窗口，又短到收尾后的重连基本不会
// 落在里面（快照不带 tool_result 的图片，长时间用快照顶替 hydrate 会丢缩略图）。
const ENDED_GRACE_MS = 3_000;

/** @type {Map<string, object>} sessionId → live turn state */
const liveTurns = new Map();

/**
 * sessionId → 最近一次 run.context_usage 事件（2026-07-30）
 *
 * 跟 liveTurns 分开活着：turn 一结束 liveTurns 就清，但"这个会话现在装了多少上下文"
 * 在两轮之间照样成立 —— 而那恰恰是用户最想看它的时刻（要不要先压缩再开新活）。
 *
 * query 结束也**不清**：关掉标签页就会触发 grace 超时关 session，而下次打开这个会话
 * 时 SDK 从同一份 jsonl resume，上下文体量基本还是那么大。这时给个带"当前没有活跃
 * 会话"标注的旧数字（live:false），比一句"还没开始对话"有用得多。只有 query 活着时才向 SDK 现问
 * （见 GET /sessions/:sid/context-usage），所以准确的那条路一直优先。
 *
 * 只活在内存里：进程重启就没了，下一轮 turn 自然补上。
 */
const lastUsage = new Map();
const LAST_USAGE_CAP = 200;

export function getLastContextUsage(sessionId) {
  return lastUsage.get(sessionId) || null;
}

/**
 * 不变量守卫：只记 Events.contextUsage 构造出来的那种形状。
 *
 * `run.context_usage` 曾经有两个生产者，字段名对不上：session-loop 每条 assistant
 * message 后发 { totalTokens, maxTokens, percentage }（前端读这套），hooks.js 的 Stop
 * handler 每轮收尾发 { used, max, percent, categories }。前端靠 store 的"不覆盖已有值"
 * 侥幸没显形，但每轮的**最后**一条恰好总是后者，凡是"取最新一条"的下游拿到的都是
 * 一片 undefined —— 这个记忆层就是这么栽的。两个生产者已经合并成一个构造函数
 * （2026-07-30），这里留一道守卫：以后再冒出第三种形状，是它被丢掉，不是这里出错数。
 */
function rememberUsage(sid, evt) {
  if (typeof evt.totalTokens !== 'number') return;
  if (lastUsage.size >= LAST_USAGE_CAP && !lastUsage.has(sid)) {
    // 先进先出丢一条：进程活得久了不至于攒着所有历史 session
    const oldest = lastUsage.keys().next().value;
    if (oldest) lastUsage.delete(oldest);
  }
  lastUsage.set(sid, evt);
}

function truncate(s) {
  if (typeof s !== 'string') return s;
  if (s.length <= MAX_TOOL_TEXT) return s;
  return s.slice(0, MAX_TOOL_TEXT) + `\n…[截断，共 ${s.length} 字符]`;
}

/**
 * 给 project bus 挂折叠订阅（幂等 —— broker.getProjectBus 每次创建 bus 时调）。
 */
export function attachLiveTurnTracker(bus) {
  if (bus.__liveTurnTracked) return;
  bus.__liveTurnTracked = true;
  bus.subscribe('*', fold);
}

/**
 * 取 session 当前 turn 的快照；没有在跑、且上一轮已过 grace 期 → null。
 * 返回值直接可作 ws.live_turn 帧 payload（messages 是前端 display 形态）。
 *
 * running=false 表示这是刚结束那一轮的尾巴（grace 期内），前端据此**只合并消息、
 * 不把自己切回 streaming 态**。
 */
export function getLiveTurnSnapshot(sessionId) {
  const st = liveTurns.get(sessionId);
  if (!st) return null;
  if (st.endedAt && Date.now() - st.endedAt > ENDED_GRACE_MS) {
    liveTurns.delete(sessionId);
    return null;
  }
  return {
    runId: st.runId,
    seq: st.seq,
    startedAt: st.startedAt,
    running: !st.endedAt,
    messages: st.messages,
    contextUsage: st.contextUsage,
  };
}

function fold(evt) {
  const sid = evt.sessionId;
  if (!sid) return;

  // 记在 liveTurns 之外：turn 结束、快照删掉之后，这个数字还要继续给 composer
  // 的 [+] 菜单用。放在 st 判空之前，快照已经清了也照记。
  if (evt.type === 'run.context_usage') rememberUsage(sid, evt);

  if (evt.type === 'run.start') {
    liveTurns.set(sid, {
      runId: evt.runId || null,
      startedAt: evt.ts || new Date().toISOString(),
      seq: evt.seq || 0,
      messages: [],
      contextUsage: null,
      endedAt: null,
      _msgCounter: 0,
    });
    return;
  }

  const st = liveTurns.get(sid);
  if (!st) return;

  // 已收尾的那一轮只留着给 grace 期内的重连当权威快照，不再吸新事件
  // （新一轮由上面的 run.start 整块换掉）。seq 照常推进，免得尾随订阅从旧游标
  // 起把这轮已经放过的事件再放一遍。
  if (st.endedAt) {
    if (evt.type === 'run.query.end' || Date.now() - st.endedAt > ENDED_GRACE_MS) {
      liveTurns.delete(sid);
      return;
    }
    if (typeof evt.seq === 'number' && evt.seq > st.seq) st.seq = evt.seq;
    return;
  }

  // stale 事件（老 turn 的尾巴）不折叠也不清新 turn 的状态
  const runMatches = !evt.runId || !st.runId || evt.runId === st.runId;

  switch (evt.type) {
    case 'run.delta.text':
      if (runMatches) appendText(st, 'assistant', evt.text, evt.parentToolUseId);
      break;
    case 'run.delta.thinking':
      if (runMatches) appendText(st, 'thinking', evt.text, evt.parentToolUseId);
      break;
    case 'run.tool_use.started':
      if (runMatches && evt.blockId && !st.messages.some(m => m.id === evt.blockId)) {
        st.messages.push({
          id: evt.blockId, role: 'tool', toolName: evt.name,
          toolInput: undefined, status: 'running', runId: st.runId,
          ...(evt.parentToolUseId ? { parentToolUseId: evt.parentToolUseId } : {}),
        });
      }
      break;
    case 'run.delta.tool_use': {
      if (!runMatches) break;
      const existing = st.messages.find(m => m.role === 'tool' && m.id === evt.blockId);
      if (existing) existing.toolInput = evt.input;
      else if (evt.blockId) {
        st.messages.push({
          id: evt.blockId, role: 'tool', toolName: evt.name,
          toolInput: evt.input, status: 'running', runId: st.runId,
          ...(evt.parentToolUseId ? { parentToolUseId: evt.parentToolUseId } : {}),
        });
      }
      break;
    }
    case 'run.delta.tool_result': {
      if (!runMatches) break;
      const tool = st.messages.find(m => m.role === 'tool' && m.id === evt.blockId);
      if (tool) {
        tool.status = evt.ok ? 'success' : 'error';
        if (evt.output !== undefined) tool.toolOutput = truncate(typeof evt.output === 'string' ? evt.output : JSON.stringify(evt.output));
        if (evt.error) tool.toolError = truncate(typeof evt.error === 'string' ? evt.error : JSON.stringify(evt.error));
        // images 不进快照：base64 体积大，turn 结束后 jsonl hydrate 会带回来
      }
      break;
    }
    case 'run.tool_use_summary': {
      if (!runMatches || !evt.summary) break;
      const ids = Array.isArray(evt.blockIds) ? evt.blockIds : [];
      const hit = st.messages.find(m => m.role === 'tool' && ids.includes(m.id));
      if (hit) hit.groupSummary = evt.summary;
      break;
    }
    case 'run.context_usage':
      if (runMatches) st.contextUsage = evt;
      break;
    case 'run.done':
    case 'run.error':
    case 'run.cancelled':
      // 不立刻删：留 grace 期给"收尾瞬间重连"当权威快照（见文件头说明）
      if (runMatches) {
        st.endedAt = Date.now();
        if (typeof evt.seq === 'number' && evt.seq > st.seq) st.seq = evt.seq;
      }
      return;
    case 'run.query.end':
      liveTurns.delete(sid);
      return;
    default:
      break;
  }

  // 所有本 session 事件都推进快照游标（包括未折叠类型）——
  // 重连订阅从 seq 起，不折叠的事件类型（queue depth 等）丢了也无碍（幂等 UI 状态）
  if (typeof evt.seq === 'number' && evt.seq > st.seq) st.seq = evt.seq;
}

function appendText(st, role, text, parentToolUseId = null) {
  if (!text) return;
  const last = st.messages[st.messages.length - 1];
  // 子代理时间轴：不同 parent 的流不互吸（跟前端 lib/chat-stream.js 同构）
  if (last && last.role === role && (last.parentToolUseId || null) === (parentToolUseId || null)) {
    last.content = (last.content || '') + text;
    return;
  }
  st.messages.push({
    id: `${st.runId || 'live'}:m${st._msgCounter++}`,
    ...(parentToolUseId ? { parentToolUseId } : {}),
    role,
    content: text,
    runId: st.runId,
  });
}
