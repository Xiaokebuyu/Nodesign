/**
 * lib/ingress/tool-reference.js —— ToolSearch 结果的 `tool_reference` 块（「这些工具现在可用了」）只有 Anthropic
 * 第一方接口认。之前非文本块一律丢，丢空了就成了 `(empty)` —— 09-08 桌面版一个会话里 GLM 连搜七次以为没搜到。
 * CLI 收到 tool_reference 后会把那些工具的 schema 加进下一发的 tools，所以这里只用告诉模型「已装载、直接调」。
 * 两个读者：transformForUpstream（Anthropic 透传腿，改 messages）与 openai-chat 的 splitToolResult（文案同一处）。
 */

export function toolReferenceText(names) {
  return `已装载 ${names.length} 个工具，现在可以直接调用（不必再 ToolSearch）：${names.join('、')}`;
}

/** tool_result 里的 tool_reference 块 → 一条 text 块。原地改，返回改没改 */
export function flattenToolReferences(messages) {
  let changed = false;
  for (const msg of messages) {
    if (msg?.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== 'tool_result' || !Array.isArray(block.content)) continue;
      const refs = block.content.filter((b) => b?.type === 'tool_reference' && b.tool_name).map((b) => b.tool_name);
      if (!refs.length) continue;
      block.content = [...block.content.filter((b) => b?.type !== 'tool_reference'), { type: 'text', text: toolReferenceText(refs) }];
      changed = true;
    }
  }
  return changed;
}


/**
 * assistant 历史里没有 signature 的 thinking / redacted_thinking 块剥掉（openai-chat 转换层合成的思考块没签名，
 * Anthropic 协议的上游会 400）。剥空了的消息补一个占位文本，别留空 content。原地改，返回改没改。
 */
export function stripUnsignedThinking(messages) {
  let changed = false;
  for (const msg of messages) {
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const kept = msg.content.filter((b) => !((b?.type === 'thinking' || b?.type === 'redacted_thinking') && !b.signature));
    if (kept.length === msg.content.length) continue;
    msg.content = kept.length ? kept : [{ type: 'text', text: '(思考略)' }];
    changed = true;
  }
  return changed;
}
