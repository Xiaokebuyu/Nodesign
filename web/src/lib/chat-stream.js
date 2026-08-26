/**
 * chat-stream.js — 聊天流折叠的纯 reducer（2026-07-28 重构 1）
 *
 * messages 状态机原本散在 ProjectWorkspace.handleEvent 的十几个 case 里，
 * 每个坑（cross-turn 粘连 / WS 重放去重 / hydrate 覆盖乐观消息 / live_turn
 * 快照接管）都是真机踩出来的。抽成纯函数后这些语义第一次可以单测固化
 * （chat-stream.test.js），改动不再靠胆量。
 *
 * 约定：所有函数无副作用；没有变化时返回原引用（React setState 短路）。
 * message 形状：{ id, role: 'user'|'assistant'|'thinking'|'tool', content?,
 *   runId?, parentToolUseId?, hydrated?, isStreaming?,
 *   toolName?, toolInput?, toolOutput?, toolError?, toolImages?, status? }
 *
 * parentToolUseId：子代理时间轴用 —— server 透传 SDK 的 parent_tool_use_id，
 * 前端按它把流拆成「对话」主线和每个子代理自己的时间轴。
 */

import { newId } from './helpers.js';

/** 关掉所有 thinking 消息的流式光标（run 结束 / 切到非 thinking 内容时调）*/
export function clearThinkingStreaming(messages) {
  let changed = false;
  const next = messages.map(m => {
    if (m.role === 'thinking' && m.isStreaming) {
      changed = true;
      return { ...m, isStreaming: false };
    }
    return m;
  });
  return changed ? next : messages;
}

/**
 * 同 role 连续 text delta 累加为一条消息；否则 push 新消息。
 * merge 条件（Phase A.5）：role 同 + runId 同（或都没）+ 非 hydrate 历史
 * + parentToolUseId 同（子代理的流不吸主线 delta，反之亦然）。
 * thinking 自带 isStreaming=true；非 thinking 内容产生时自动关掉之前所有
 * thinking 的流式光标（那段思考已经结束了）。
 */
export function appendTextDelta(messages, role, text, runId, parentToolUseId = null) {
  if (!text) return messages;
  const cleared = role === 'thinking' ? messages : clearThinkingStreaming(messages);
  const last = cleared[cleared.length - 1];
  if (
    last
    && last.role === role
    && !last.hydrated
    && (!runId || !last.runId || last.runId === runId)
    && (last.parentToolUseId || null) === (parentToolUseId || null)
  ) {
    const merged = { ...last, content: (last.content || '') + text };
    if (role === 'thinking') merged.isStreaming = true;
    if (runId && !last.runId) merged.runId = runId;
    return [...cleared.slice(0, -1), merged];
  }
  const created = { id: newId('msg'), role, content: text };
  if (role === 'thinking') created.isStreaming = true;
  if (runId) created.runId = runId;
  if (parentToolUseId) created.parentToolUseId = parentToolUseId;
  return [...cleared, created];
}

/**
 * 流事件 → messages 的统一入口。不认识的事件原样返回（调用方可用引用相等
 * 判断"这事件与聊天流无关"）。stale 判定是调用方的事（协议层守卫）。
 */
export function reduceChatEvent(messages, evt) {
  switch (evt.type) {
    case 'run.delta.text':
      return appendTextDelta(messages, 'assistant', evt.text, evt.runId, evt.parentToolUseId);

    case 'run.delta.thinking':
      return appendTextDelta(messages, 'thinking', evt.text, evt.runId, evt.parentToolUseId);

    case 'run.tool_use_summary': {
      // SDK helper 对一批工具调用的一句话总结 —— 贴到这批里第一条工具消息上，
      // TimelineGroup 拿它当折叠标题（比本地切 thinking 头几十字准得多）。
      const ids = Array.isArray(evt.blockIds) ? evt.blockIds : [];
      if (!evt.summary || ids.length === 0) return messages;
      const idx = messages.findIndex(m => m.role === 'tool' && ids.includes(m.id));
      if (idx < 0) return messages;
      if (messages[idx].groupSummary === evt.summary) return messages;
      const next = [...messages];
      next[idx] = { ...next[idx], groupSummary: evt.summary };
      return next;
    }

    case 'run.tool_use.started': {
      // 工具 streaming 起点：立即显示 icon + name，input 等 delta.tool_use 补。
      // 同 blockId 已在（WS 重连重放）→ noop
      if (!evt.blockId || messages.some(m => m.role === 'tool' && m.id === evt.blockId)) {
        return messages;
      }
      return [...messages, {
        id: evt.blockId,
        role: 'tool',
        toolName: evt.name,
        toolInput: undefined,
        status: 'running',
        runId: evt.runId,
        ...(evt.parentToolUseId ? { parentToolUseId: evt.parentToolUseId } : {}),
      }];
    }

    case 'run.delta.tool_use': {
      // assistant message 完成时的完整 tool_use block。同 blockId 已在 → 补 input；
      // 不在 → 补 push（兼容 SDK 没出 content_block_start 的 stream 边界）
      const idx = messages.findIndex(m => m.role === 'tool' && m.id === evt.blockId);
      if (idx >= 0) {
        const updated = [...messages];
        updated[idx] = { ...updated[idx], toolInput: evt.input };
        return updated;
      }
      return [...messages, {
        id: evt.blockId || newId('tool'),
        role: 'tool',
        toolName: evt.name,
        toolInput: evt.input,
        status: 'running',
        runId: evt.runId,
        ...(evt.parentToolUseId ? { parentToolUseId: evt.parentToolUseId } : {}),
      }];
    }

    case 'run.delta.tool_result':
      return messages.map(m =>
        m.role === 'tool' && m.id === evt.blockId
          ? {
              ...m,
              status: evt.ok ? 'success' : 'error',
              toolOutput: evt.output,
              toolError: evt.error,
              toolImages: evt.images,
            }
          : m,
      );

    default:
      return messages;
  }
}

/**
 * ws.live_turn 快照合并：快照对本 turn 权威 —— 清掉 prev 里同 runId 的 delta
 * 累积（重连前已渲染的部分，id 体系跟快照不同会重复）+ 同 id 的工具卡，
 * 再整体附加快照。
 */
export function mergeLiveTurnSnapshot(messages, snapMessages, runId) {
  const snaps = Array.isArray(snapMessages) ? snapMessages : [];
  const snapIds = new Set(snaps.map(m => m.id));
  const base = messages.filter(m =>
    !(m.runId && runId && m.runId === runId) && !snapIds.has(m.id)
  );
  return [...base, ...snaps];
}

/**
 * hydrate 合并：
 * - display 空而 current 有内容（jsonl 还没 flush）→ 信任 current 不替换
 * - display 缺乐观 user msg（还在 inputQueue 没落 JSONL）→ 保留 orphan
 */
export function mergeHydrated(messages, display) {
  if (display.length === 0 && messages.length > 0) return messages;
  const displayUserContents = new Set(
    display.filter(m => m.role === 'user').map(m => (m.content || '').trim())
  );
  const orphans = messages.filter(m =>
    m.role === 'user' && !displayUserContents.has((m.content || '').trim())
  );
  if (orphans.length > 0) return [...display, ...orphans];
  return display;
}

/**
 * 子代理收尾：把 lastAssistantMessage / 转录路径挂回对应的 Task tool message
 *（`run.subagent.stop` 带的 toolUseId 就是当初那次 Agent 调用的 id）。
 *
 * 抽出来是因为它是**纯消息变换**，跟事件路由没关系 —— 留在 ProjectWorkspace 的
 * switch 里只是让那个已经到顶的文件更胖。Message.jsx 的 ToolMessage 据此渲染
 * critique 卡（当前只有 vision-checker 有专门渲染，其余存着待用）。
 */
export function attachSubagentResult(messages, evt) {
  if (!evt?.toolUseId) return messages;
  return messages.map((m) => (m.role === 'tool' && m.id === evt.toolUseId
    ? {
        ...m,
        subagentResult: {
          lastAssistantMessage: evt.lastAssistantMessage || null,
          transcriptPath: evt.transcriptPath || null,
          agentId: evt.agentId,
          agentType: evt.agentType,
        },
      }
    : m));
}
