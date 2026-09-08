/**
 * lib/ingress/request-dump.js — 量具：ND_INGRESS_DUMP_DIR 有值时把每一发请求的形状落盘（09-08）。
 *
 * 提示词层改动的判据是「模型真收到的那份」，不是源码旁边放着的。默认关，只在实验实例开。
 * 落的是 system 全文、tools 名单、messages 数、最后一条 user 文本前 300 字、以及所有 <system-reminder> 块
 * （CLAUDE.md / 延迟工具清单 / 记忆索引走这条路注入）。不落 tool_result 正文与图片。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 把一发请求的形状落盘（不含 tool_result 正文与图片，只留 system 全文、tools 名、最后一条 user 文本前 300 字）。
 * 只在 process.env.ND_INGRESS_DUMP_DIR 非空时生效；写失败只告警。导出给测试。
 */
export function dumpRequestShape(parsed, sessionTag, dir = process.env.ND_INGRESS_DUMP_DIR) {
  if (!dir || !parsed || typeof parsed !== 'object') return null;
  const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
  let lastUser = '';
  for (let i = msgs.length - 1; i >= 0; i--) {
    const c = msgs[i]?.content;
    if (msgs[i]?.role !== 'user') continue;
    lastUser = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '');
    break;
  }
  const shape = {
    at: new Date().toISOString(), sid: sessionTag, model: parsed.model,
    system: parsed.system ?? null,
    tools: (Array.isArray(parsed.tools) ? parsed.tools : []).map((t) => t?.name).filter(Boolean),
    messages: msgs.length, lastUserText: String(lastUser).slice(0, 300),
    betas: parsed.betas ?? null, thinking: parsed.thinking ?? null, max_tokens: parsed.max_tokens ?? null,
    reminders: msgs.flatMap((m) => {
      const blocks = typeof m?.content === 'string' ? [{ type: 'text', text: m.content }] : (Array.isArray(m?.content) ? m.content : []);
      return blocks.filter((b) => b?.type === 'text' && /<system-reminder>/.test(b.text || '')).map((b) => b.text);
    }),
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${(sessionTag || 'nosid').slice(0, 8)}.json`);
    fs.writeFileSync(file, JSON.stringify(shape, null, 2));
    return file;
  } catch (err) {
    console.warn(`[model-ingress] dump 落盘失败（${dir}）：${err.message}`);
    return null;
  }
}


/** 一发请求的形状摘要（不含正文）：系统提示字数、reminder 段数、工具数、消息数、最后一条 user 字数 */
export function requestShape(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
  const sys = typeof parsed.system === 'string' ? parsed.system : (Array.isArray(parsed.system) ? parsed.system.map((b) => b?.text || '').join('') : '');
  let reminders = 0; let lastUserChars = 0;
  for (const m of msgs) {
    const blocks = typeof m?.content === 'string' ? [{ type: 'text', text: m.content }] : (Array.isArray(m?.content) ? m.content : []);
    for (const b of blocks) if (b?.type === 'text' && /<system-reminder>/.test(b.text || '')) reminders += 1;
    if (m?.role === 'user') lastUserChars = blocks.filter((b) => b?.type === 'text').reduce((n, b) => n + (b.text || '').length, 0);
  }
  return { model: parsed.model ?? null, systemChars: sys.length, reminders, tools: Array.isArray(parsed.tools) ? parsed.tools.length : 0, messages: msgs.length, lastUserChars, maxTokens: parsed.max_tokens ?? null };
}
