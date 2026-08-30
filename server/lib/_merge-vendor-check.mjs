/**
 * 真跑探针：**merge 那条 glm 的厂商口径还对不对**（08-28 建，08-30 深夜换判据）。
 *   node --env-file=.env server/lib/_merge-vendor-check.mjs [发数]
 *
 * ⭐⭐ 这个探针的形状是**故意挑的：九张图，散在多轮历史里**。九是唯一有意义的数字 ——
 *   particle 的内联图上限是 **8 张**，第 9 张起一律回
 *   「GLM requests accept at most 8 inline PNG, JPEG, WEBP, or GIF data URLs…」400；
 *   zai 到 20 张都收得下、抽问第 1/10/16 张里的词都念得出来（是真读了，不是悄悄丢）。
 *   本站一个真会话就有 51 张图，所以这条线不是边角是主路径。
 * ⛔⛔ **别把张数改小。**08-30 白天那趟就是拿三张图复测，得出「particle 的多图 400 已经没了
 *   36/36 全通」，然后把行改成 particle 打头 —— 上线四十分钟后用户的会话就 400 了。
 *   那条限制不是消失，是从 1 张放宽到 8 张，而三张的题目它根本不需要拦。
 *   同族老账见 feedback-verify-the-instrument：**判一道闸在不在，要给它一个它必须拦的东西。**
 * ⛔ 也别改成「九张图塞同一条消息」：那形状两家的表现同样是按张数卡，但读图的弱项测不出来
 *   （particle 还有一条次要弱项：图散在多轮 + 请求**没声明 tools** 时只看得见最后一张）。
 *
 * 三条判据：
 *   ① 真通路上九张图跨轮发，第 1/5/9 张里的词全认得出来（判据是**认不认得出图里那个词**，
 *      不是"答得对不对"——后者在轮盘下本来就时对时错，08-27 就是这么误判的）。
 *      行的第一顺位被人换成 particle 的话，这一步会直接 400。
 *   ② ⛔ 直连网关看 `x-merge-vendor`：必须落 zai，**一发都不许落到 baseten**
 *      （同一发请求实测 $0.000626，是 particle 的 48 倍）。入口不转发上游响应头，只能直连看。
 *   ③ 演出行 + 量具自检：同样这九张图走 `glm-5.3-flash-rp`（那条点死 particle）**必须被拦**，
 *      而且拦出来的得是人话（upstream-error-hints 把那句英文翻成"换到设计那条线"）。
 *      它要是通了，说明 particle 抬了上限 —— 那就该回头重新评估两条线还分不分。
 */
import { getOrStartIngress, registerIngressSession, stopIngress } from './model-ingress.js';
import { resolveModelRoute, resolveWireModel } from '../engine/agent/model-context.js';
import sharp from 'sharp';

const APP = 'glm-5.3-flash-merge';
const N = Number(process.argv[2]) || 6;
const wire = resolveWireModel(APP);
console.log(`[merge-vendor] ${APP} bodyExtra=${JSON.stringify(wire?.bodyExtra)}`);

/** 截图尺寸、里面印一个词 —— 认不认得出这个词就是"瞎没瞎图"的判据 */
async function wordImg(word, bg) {
  const svg = `<svg width="640" height="400"><rect width="640" height="400" fill="${bg}"/><text x="40" y="230" font-size="90" font-family="DejaVu Sans" fill="#111">${word}</text></svg>`;
  return (await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64');
}
const WORDS = ['MELON', 'WALNUT', 'RIVET', 'LANTERN', 'COBALT', 'THISTLE', 'QUARRY', 'MARROW', 'PEBBLE'];
const BG = ['#e8e0c8', '#cfe0ee', '#e8d0d0', '#d8e8d0', '#eee0f0', '#e0e8f8', '#f8e8d0', '#d0e8e8', '#e8e8c0'];
const DATA = await Promise.all(WORDS.map((w, i) => wordImg(w, BG[i])));
const ASK = [0, 4, 8];                       // 抽问第 1/5/9 张：头、中、尾各一个
const hit = (t) => ASK.filter((i) => new RegExp(WORDS[i], 'i').test(t)).length;

// ── ① 真通路：九张图跨轮发（particle 打头的话这一步必 400） ──
const img = (d) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: d } });
const messages = [];
DATA.forEach((d, i) => {
  const last = i === DATA.length - 1;
  const text = last ? `第 ${i + 1} 张。第 1、第 5、第 9 张图里各印了一个英文词，把这三个词念出来，只回三个词。` : `第 ${i + 1} 张：`;
  messages.push({ role: 'user', content: [{ type: 'text', text }, img(d)] });
  if (!last) messages.push({ role: 'assistant', content: [{ type: 'text', text: '收到。' }] });
});
const { baseUrl } = await getOrStartIngress();
registerIngressSession('mergevendor-session', APP);
const url = `${baseUrl}/__nd/mergevendor-session/v1/messages`;
const body = { model: resolveModelRoute(APP).sdkAlias, max_tokens: 300, messages };

let ok = 0; let blind = 0; let err = 0;
for (let i = 0; i < N; i++) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'placeholder', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) { err++; console.log(`  ${i + 1}. ${r.status} ${t.replace(/\s+/g, ' ').slice(0, 150)}`); continue; }
  const said = (JSON.parse(t).content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').replace(/\s+/g, ' ');
  const n = hit(said);
  if (n === 3) { ok++; console.log(`  ${i + 1}. 200  三词全认  ${said.slice(0, 60)}`); }
  else { blind++; console.log(`  ${i + 1}. 200  ⛔ 只认出 ${n}/3 个词：${said.slice(0, 110)}`); }
}
console.log(`\n① 真通路九张图：全认 ${ok}/${N}   瞎图 ${blind}   报错 ${err}`);

// ── ③ 演出行：同样这九张图**必须**被拦，且拦出来的得是人话不是英文 ──
registerIngressSession('mergevendor-rp', 'glm-5.3-flash-rp');
// ⚠️ 流式/非流式**两条都要走**：转换层的 4xx 是孪生的两条路，翻译第一版只挂了流式那条，
//    而探针当时只走非流式 —— 一跑就撞出来了。反过来只验流式同样会漏，所以这里两条都发。
let rpToothy = true;
for (const streaming of [false, true]) {
  const r = await fetch(`${baseUrl}/__nd/mergevendor-rp/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'placeholder', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ ...body, model: resolveModelRoute('glm-5.3-flash-rp').sdkAlias, ...(streaming ? { stream: true } : {}) }),
  });
  const t = await r.text();
  const ok3 = r.status === 400 && /最多带 8 张图/.test(t) && /设计/.test(t);
  if (!ok3) rpToothy = false;
  const shape = streaming ? '流式' : '非流式';
  if (ok3) console.log(`③ 演出行（${shape}）照旧拦在 8 张，回的是人话`);
  else console.log(`③ ⚠️ 演出行（${shape}）没按预期拦下九张图（${r.status}）—— 要么 particle 抬了上限（那该回头重估两条线还分不分），要么这一条路上的翻译断了：${t.replace(/\s+/g, ' ').slice(0, 160)}`);
}

await stopIngress();

// ── ② 直连网关：谁在服务，有没有落到贵 10 倍那家 ──
const KEY = process.env.NODESIGN_UPSTREAM_MERGE_KEY;
const GW = 'https://api-gateway.merge.dev/v1/chat/completions';
const dist = {};
if (KEY) {
  for (let i = 0; i < N; i++) {
    const r = await fetch(GW, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: wire.wireModel, max_tokens: 30, messages: [{ role: 'user', content: '说 ok' }], ...(wire.bodyExtra || {}) }),
    });
    await r.text();
    const v = r.headers.get('x-merge-vendor') || '?';
    dist[`${r.status}/${v}`] = (dist[`${r.status}/${v}`] || 0) + 1;
  }
  console.log(`② 厂商分布 ${JSON.stringify(dist)}`);
} else console.log('② 跳过（没钥匙）');


const toBaseten = Object.keys(dist).some((k) => k.includes('baseten'));
const toParticle = Object.keys(dist).some((k) => k.includes('particle'));
if (toBaseten) console.log('⛔ 有请求落到 baseten —— 贵 48 倍，去看 model-table 那行的 vendors');
if (toParticle) console.log('⛔ **默认行**落到 particle —— 带图的会话会在第 9 张上 400，zai 该排第一');
process.exit(blind > 0 || err > 0 || toBaseten || toParticle || !rpToothy ? 1 : 0);
