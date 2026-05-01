/**
 * session-to-messages.js —— SDK SessionMessage[] → 前端展示 messages[]
 *
 * SDK getSessionMessages 返回的 JSONL 行结构（每条 SessionMessage）：
 *   {
 *     type: 'user' | 'assistant' | 'system' | 'queue-operation' | 'attachment'
 *           | 'file-history-snapshot' | 'last-prompt',
 *     uuid, sessionId, timestamp, parentUuid?, ...
 *     message: {                            // Anthropic API standard message
 *       role: 'user' | 'assistant',
 *       content: [
 *         { type: 'text', text },
 *         { type: 'thinking', thinking, signature? },
 *         { type: 'tool_use', id, name, input },
 *         { type: 'tool_result', tool_use_id, content, is_error? },
 *         ...
 *       ],
 *       usage?, stop_reason?, ...
 *     }
 *   }
 *
 * 转换目标：与 Project.jsx WS 实时累加产生的 messages 结构对齐，hydrate
 * 后续 WS delta 能继续累加不冲突（具体见 [Project.jsx handleEvent](routes/Project.jsx)）。
 *
 * - user 文本 → { role: 'user', content }
 * - assistant text block → { role: 'assistant', content }
 * - assistant thinking block → { role: 'thinking', content }
 * - assistant tool_use → { role: 'tool', toolName, toolInput, status: 'success' }
 *   （状态后面 tool_result 来时覆盖）
 * - user tool_result block → 找 toolUseId 关联的 tool message 更新 status/output/error/images
 *
 * 跳过：queue-operation / attachment / file-history-snapshot / last-prompt
 *       （SDK 内部运维消息，前端不展示）
 */

export function sessionMessagesToDisplay(sessionMessages) {
  if (!Array.isArray(sessionMessages)) return [];
  const display = [];
  const toolIndexById = new Map();

  for (const sm of sessionMessages) {
    if (!sm || typeof sm !== 'object') continue;
    if (sm.type !== 'user' && sm.type !== 'assistant') continue;

    const inner = sm.message;
    if (!inner) continue;

    const role = sm.type;
    const content = inner.content;

    // user message 也可能是 string content（简单纯文本）
    if (typeof content === 'string') {
      display.push({ id: sm.uuid, role: 'user', content });
      continue;
    }

    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;

      switch (block.type) {
        case 'text': {
          if (!block.text) break;
          // hydrate 用 sm.uuid + suffix 当稳定 id（避免 React key 冲突）
          display.push({
            id: `${sm.uuid}:text`,
            role: role === 'user' ? 'user' : 'assistant',
            content: block.text,
          });
          break;
        }
        case 'thinking': {
          if (!block.thinking) break;
          display.push({
            id: `${sm.uuid}:thinking`,
            role: 'thinking',
            content: block.thinking,
            // hydrate 历史不再 streaming
            isStreaming: false,
          });
          break;
        }
        case 'tool_use': {
          const idx = display.length;
          toolIndexById.set(block.id, idx);
          display.push({
            id: block.id,
            role: 'tool',
            toolName: block.name,
            toolInput: block.input,
            // 默认假设成功；下面 user 的 tool_result 来时覆盖
            status: 'success',
          });
          break;
        }
        case 'tool_result': {
          const idx = toolIndexById.get(block.tool_use_id);
          if (idx == null) break;
          const tool = display[idx];
          tool.status = block.is_error ? 'error' : 'success';
          const c = block.content;
          if (block.is_error) {
            tool.toolError = stringifyToolContent(c);
          } else if (typeof c === 'string') {
            tool.toolOutput = c;
          } else if (Array.isArray(c)) {
            const texts = [];
            const images = [];
            for (const cb of c) {
              if (!cb || typeof cb !== 'object') continue;
              if (cb.type === 'text' && cb.text) texts.push(cb.text);
              else if (cb.type === 'image' && cb.source?.data) {
                images.push({ data: cb.source.data, mediaType: cb.source.media_type });
              }
            }
            if (texts.length) tool.toolOutput = texts.join('\n');
            if (images.length) tool.toolImages = images;
          }
          break;
        }
        default:
          // image / document / 其他 block 暂不展示在 chat
          break;
      }
    }
  }

  return display;
}

function stringifyToolContent(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const texts = c
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text);
    if (texts.length) return texts.join('\n');
  }
  try { return JSON.stringify(c); } catch { return String(c); }
}
