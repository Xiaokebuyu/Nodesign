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
 *   （状态后面 tool_result 来时覆盖；整份转录里都没有它的 tool_result → 标成被中断的失败，见文末）
 * - user tool_result block → 找 toolUseId 关联的 tool message 更新 status/output/error/images
 *
 * 跳过：queue-operation / attachment / file-history-snapshot / last-prompt
 *       （SDK 内部运维消息，前端不展示）
 */

import { t } from './i18n.js';

export function sessionMessagesToDisplay(sessionMessages) {
  if (!Array.isArray(sessionMessages)) return [];
  const display = [];
  const toolIndexById = new Map();
  const resolvedToolIds = new Set();

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

    // user role 单独处理：合并所有 text block 推一条 display msg，id 用纯 sm.uuid
    // —— SDK Query.rewindFiles(userMessageId) 只认 SDKUserMessage.uuid（纯 36-char），
    // 之前 hydrate 加 ':text' 后缀让 SDK 不识别，"回到此处"按钮看似无反应 = 后端
    // 返 canRewind:false，toast 一闪即逝。
    // composeUserMessage 注入的 <system>...</system> 也会变成 user text block，跟用户
    // chat 文本一起 join；显示侧的 noise 是另一回事，不影响 id 正确性。
    if (role === 'user') {
      const userTexts = [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && block.text) {
          userTexts.push(block.text);
        } else if (block.type === 'tool_result') {
          // 关联回之前 assistant tool_use 的 display msg（status / output / error / images）
          const idx = toolIndexById.get(block.tool_use_id);
          if (idx == null) continue;
          const tool = display[idx];
          resolvedToolIds.add(block.tool_use_id);
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
        }
      }
      if (userTexts.length > 0) {
        display.push({
          id: sm.uuid,  // 纯 SDK uuid → SDK rewindFiles 能认
          role: 'user',
          content: userTexts.join('\n\n'),
        });
      }
      continue;
    }

    // assistant role：保持原 per-block 推送（thinking / text / tool_use 各占一条 display msg）
    // 同 sm 内多个 text / thinking block 用 blockIdx 区分（thinking 模式下 content 经常
    // 是 [thinking, text, thinking, text] 交替，纯 sm.uuid+":text" 会撞 React duplicate key）
    for (const [blockIdx, block] of content.entries()) {
      if (!block || typeof block !== 'object') continue;

      switch (block.type) {
        case 'text': {
          if (!block.text) break;
          display.push({
            id: `${sm.uuid}:text:${blockIdx}`,
            role: 'assistant',
            content: block.text,
            // 历史消息标记：appendTextDelta 不把新一轮的 delta 粘到 hydrate 消息尾部
            hydrated: true,
          });
          break;
        }
        case 'thinking': {
          if (!block.thinking) break;
          display.push({
            id: `${sm.uuid}:thinking:${blockIdx}`,
            role: 'thinking',
            content: block.thinking,
            // hydrate 历史不再 streaming
            isStreaming: false,
            hydrated: true,
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
          resolvedToolIds.add(block.tool_use_id);
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

  // 没拿到结果的工具（2026-09-13，流式与并行现状调查缺口 3）：以前默认 success，被中断的回合刷新后
  // 历史里显示「成功」。CLI 正常停止会给被打断的工具补一条 is_error 的结果（上面那支已经覆盖），走到这里的
  // 是进程被关 / 服务重启这类连补结果都没来得及写的情况。还在跑的回合不受影响：紧随其后的 ws.live_turn
  // 快照对本轮权威，会用同 id 的 running 工具卡把这里替换掉（chat-stream.mergeLiveTurnSnapshot）。
  for (const [id, idx] of toolIndexById) {
    if (resolvedToolIds.has(id)) continue;
    const tool = display[idx];
    tool.status = 'error';
    tool.interrupted = true;
    tool.toolError = t('没有拿到结果：这一轮在它执行完之前被中断了（停止、断线或服务重启）');
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
