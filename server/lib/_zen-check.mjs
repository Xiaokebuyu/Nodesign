/**
 * 真跑探针：起 ingress，按 SDK 会说的 Anthropic 格式（alias 名）打一条 openai-chat 行，验证转换层。
 *   node --env-file=.env server/lib/_zen-check.mjs [text|tool|image|stream|parallel|count|all] [appModel]
 *
 * 08-26 起模型 id 是第二个参数（默认 glm-5.3-flash，接替下架的 ox-alpha）—— 换行不用再改这个文件。
 * ⚠️ 请求路径必须带会话前缀 `/__nd/<sid>/`：今天的新行不写 sdkAlias、走共用别名，全表反查认不出它，
 * 只有注册过的会话知道自己是谁（见 lib/ingress/session-routes.js）。直呼 appModel id 也行。
 */
import { getOrStartIngress, registerIngressSession, stopIngress } from './model-ingress.js';
import { resolveModelRoute } from '../engine/agent/model-context.js';

const which = process.argv[2] || 'all';
const APP = process.argv[3] || 'glm-5.3-flash';
const route = resolveModelRoute(APP);
if (route.mode !== 'api') { console.error(`[zen-check] ${APP} 不是 API 行（mode=${route.mode}）—— 名字打错了？`); process.exit(1); }
console.log(`[zen-check] ${APP} → ${route.upstreamId} / ${resolveModelRoute(APP).sdkAlias}  (wire 见下)`);
const { baseUrl } = await getOrStartIngress();
registerIngressSession('zenprobe-session', APP);
const url = `${baseUrl}/__nd/zenprobe-session/v1/messages`;
const MODEL = route.sdkAlias;
const TXT = (s) => [{ type: 'text', text: s }];
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFklEQVR4nGP4z8CAFTEMSQkGBqIkABzhNbvHCQN6AAAAAElFTkSuQmCC';
const T = [{ name: 'get_weather', description: 'Get weather', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];
async function post(body, { stream = false } = {}) {
  const t0 = Date.now();
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'placeholder', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, dt: Date.now() - t0 };
}
function show(name, r) { console.log(`\n### ${name} → ${r.status} (${r.dt}ms)\n${r.text.slice(0, 700)}`); }
if (which === 'all' || which === 'text') show('text', await post({ model: MODEL, max_tokens: 300, system: [{ type: 'text', text: 'Answer tersely.' }], messages: [{ role: 'user', content: TXT('用三个词打个招呼') }], thinking: { type: 'adaptive' } }));
if (which === 'all' || which === 'tool') show('tool round trip', await post({ model: MODEL, max_tokens: 600, tools: T, messages: [{ role: 'user', content: TXT('Weather in Tokyo? Use the tool.') }, { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Tokyo' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '22C sunny' }] }] }));
if (which === 'all' || which === 'image') show('image in tool_result', await post({ model: MODEL, max_tokens: 300, tools: [{ name: 'screenshot', description: 'shot', input_schema: { type: 'object', properties: {} } }], messages: [{ role: 'user', content: TXT('Take a screenshot; what colour? one word') }, { role: 'assistant', content: [{ type: 'tool_use', id: 'call_2', name: 'screenshot', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_2', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] }] }] }));
if (which === 'all' || which === 'stream') {
  const r = await post({ model: MODEL, max_tokens: 600, stream: true, tools: T, messages: [{ role: 'user', content: TXT('Weather in Paris? Use the tool.') }] });
  console.log(`\n### stream+tool → ${r.status} (${r.dt}ms)`);
  const evs = r.text.split('\n').filter(l => l.startsWith('event:')).map(l => l.slice(6).trim());
  console.log('events:', evs.join(' '));
  for (const l of r.text.split('\n')) if (/tool_use|stop_reason|usage/.test(l)) console.log(' ', l.slice(0, 260));
}
if (which === 'all' || which === 'parallel') {
  const T2 = [...T, { name: 'get_time', description: 'Get local time', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];
  const r = await post({ model: MODEL, max_tokens: 800, stream: true, tools: T2, messages: [{ role: 'user', content: TXT('I need BOTH the weather and the local time in Tokyo. Call both tools in parallel in one go.') }] });
  const starts = r.text.split('\n').filter(l => l.includes('content_block_start') && l.includes('tool_use'));
  const deltas = r.text.split('\n').filter(l => l.includes('input_json_delta'));
  console.log(`\n### parallel tools → ${r.status} (${r.dt}ms) tool_use blocks=${starts.length} json deltas=${deltas.length}`);
  for (const l of starts) console.log(' ', l.slice(0, 200));
  for (const l of deltas) console.log(' ', l.slice(0, 160));
}
if (which === 'all' || which === 'count') show('count_tokens', await post({ model: MODEL, messages: [{ role: 'user', content: 'hello world' }] }).then(r => r));
await stopIngress();
