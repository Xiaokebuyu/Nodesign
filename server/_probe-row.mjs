/** 起真 ingress 打一条表里的行：文本 / 图 / 工具 / 流式 / 缓存。用法：node server/_probe-row.mjs <modelId>（先 set -a; . ./.env） */
import { getOrStartIngress, stopIngress } from './lib/model-ingress.js';
import { registerIngressSession, unregisterIngressSession } from './lib/ingress/session-routes.js';
const MODEL = process.argv[2];
const sid = 'probe-row-0000-0000-0000-000000000000';
const { baseUrl: url } = await getOrStartIngress();
registerIngressSession(sid, MODEL);
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
async function send(tag, body, stream) {
  const t0 = Date.now();
  const r = await fetch(`${url}/__nd/${sid}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'x', 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: MODEL, max_tokens: 200, stream, ...body }) });
  const text = await r.text();
  let stop = null, usage = null, tools = 0, textOut = '';
  if (stream) { for (const l of text.split('\n')) { if (!l.startsWith('data:')) continue; try { const j = JSON.parse(l.slice(5)); if (j.type === 'message_delta') { stop = j.delta?.stop_reason; usage = j.usage; } if (j.type === 'content_block_start' && j.content_block?.type === 'tool_use') tools++; if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') textOut += j.delta.text; } catch {} } }
  else { try { const j = JSON.parse(text); stop = j.stop_reason; usage = j.usage; tools = (j.content || []).filter((b) => b.type === 'tool_use').length; textOut = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''); } catch {} }
  console.log(`${tag.padEnd(22)} ${r.status} ${Date.now() - t0}ms stop=${stop} tools=${tools} usage=${JSON.stringify(usage)} text=${JSON.stringify(textOut.slice(0, 60))}${r.status >= 400 ? ' body=' + text.slice(0, 200) : ''}`);
}
const sys = 'You are a helpful assistant. ' + 'x'.repeat(4000);
try {
  await send('1 文本 非流式', { system: sys, messages: [{ role: 'user', content: '用一句话说明海报的视觉层级。' }] }, false);
  await send('2 文本 流式 (缓存?)', { system: sys, messages: [{ role: 'user', content: '用一句话说明海报的视觉层级。' }] }, true);
  await send('3 图片', { system: sys, messages: [{ role: 'user', content: [{ type: 'text', text: '这张图主色是什么？一句话。' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] }] }, true);
  await send('4 工具 流式', { system: sys, tools: [{ name: 'look', description: '截一张图', input_schema: { type: 'object', properties: { where: { type: 'string' } }, required: ['where'] } }], messages: [{ role: 'user', content: '调用 look 工具看一眼 画布。' }] }, true);
  await send('5 tool_result 图', { system: sys, tools: [{ name: 'look', description: '截一张图', input_schema: { type: 'object', properties: {} } }], messages: [{ role: 'user', content: '看一下' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'look', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] }] }] }, true);
} finally { unregisterIngressSession(sid); await stopIngress(); }
