/**
 * 真跑探针：**merge 那条 glm 的厂商点名闸还在不在**（08-28）。
 *   node --env-file=.env server/lib/_merge-vendor-check.mjs [发数]
 *
 * ⭐ 判据是"给它一个不点名就必挂的东西"：**跨消息两张图**。08-28 实测不点名时这个形状
 * 12 发挂 8 发（particle 回「GLM image requests accept at most one inline PNG...」），
 * 点名 zai 后 6/6 通。所以这个探针全绿 = 闸活着；出现那句 400 = 点名在某处被吃掉了。
 * ⛔ 别拿"答得对不对"当判据 —— 轮盘下那个量本来就时对时错，08-27 就是这么误判的。
 */
import { getOrStartIngress, registerIngressSession, stopIngress } from './model-ingress.js';
import { resolveModelRoute, resolveWireModel } from '../engine/agent/model-context.js';
import sharp from 'sharp';

const APP = 'glm-5.3-flash-merge';
const N = Number(process.argv[2]) || 6;
const wire = resolveWireModel(APP);
console.log(`[merge-vendor] ${APP} bodyExtra=${JSON.stringify(wire?.bodyExtra)}`);

const swatch = async (rgb) => (await sharp({ create: { width: 320, height: 200, channels: 3, background: rgb } }).png().toBuffer()).toString('base64');
const A = await swatch({ r: 216, g: 30, b: 30 });
const B = await swatch({ r: 30, g: 64, b: 216 });
const img = (d) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: d } });

const { baseUrl } = await getOrStartIngress();
registerIngressSession('mergevendor-session', APP);
const url = `${baseUrl}/__nd/mergevendor-session/v1/messages`;
const MODEL = resolveModelRoute(APP).sdkAlias;

const body = {
  model: MODEL, max_tokens: 200,
  messages: [
    { role: 'user', content: [{ type: 'text', text: '第一张：' }, img(A)] },
    { role: 'assistant', content: [{ type: 'text', text: '收到。' }] },
    { role: 'user', content: [{ type: 'text', text: '两张图分别什么颜色？' }, img(B)] },
  ],
};

let pinned = 0, oneImage = 0, other = 0;
for (let i = 0; i < N; i++) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'placeholder', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
  const t = await r.text();
  if (r.ok) { pinned++; console.log(`  ${i + 1}. 200  ${(JSON.parse(t).content || []).filter(b => b.type === 'text').map(b => b.text).join(' ').replace(/\s+/g, ' ').slice(0, 60)}`); }
  else if (/at most one inline/.test(t)) { oneImage++; console.log(`  ${i + 1}. ${r.status} ⛔ 点名没生效（particle 的单图限）`); }
  else { other++; console.log(`  ${i + 1}. ${r.status} ${t.slice(0, 140)}`); }
}
console.log(`\n通 ${pinned}/${N}   点名失效 ${oneImage}   其它错 ${other}`);
await stopIngress();
process.exit(oneImage > 0 ? 1 : 0);
