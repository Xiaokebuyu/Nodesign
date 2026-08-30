/**
 * 真跑探针：**merge 那条 glm 的厂商口径还对不对**（08-28 建，08-30 晚换判据）。
 *   node --env-file=.env server/lib/_merge-vendor-check.mjs [发数]
 *
 * 08-28 的判据是「点名 zai 有没有生效」，因为当时 particle 对多图直接回 400。
 * ⭐ 那条 400 已经没了（复测 36/36 全通），行也从点死一家改成偏好序 `vendors:['zai','particle']`，
 * particle 的速度另开了一行（glm-5.3-flash-fast）。
 *
 * ⭐⭐ 这个探针的形状是**故意挑的**：三张图分三轮发、简短的 assistant 回合、**不声明 tools**
 * —— 这是唯一还能把两家分开的形状（particle 在这形状下 20 发挂 8 发，只念得出最后一张图里的词；
 * zai 20/20）。⚠️ 注意这**不是**生产的形状：本站的请求永远带 tools，带上之后 particle 也是 20/20。
 * 所以这里挂了只说明"默认行的第一顺位被人动过"，不说明快线那行有问题。
 * ⛔ 别改成"三张图塞同一条消息"：那样两家都零失败，探针会变成恒绿的摆设（我第一趟 30/30
 * 全绿就是这么被骗过去的）。
 *
 * 两条判据：
 *   ① 真通路上三个词全认得出来（判据是**认不认得出图里那个词**，不是"答得对不对"——
 *      后者在轮盘下本来就时对时错，08-27 就是这么误判的）
 *   ② ⛔ 直连网关看 `x-merge-vendor`：必须落 zai，**一发都不许落到 baseten**
 *      （同一发请求实测 $0.000626，是 particle 的 48 倍）。入口不转发上游响应头，只能直连看。
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
  const svg = `<svg width="1280" height="800"><rect width="1280" height="800" fill="${bg}"/><text x="60" y="420" font-size="160" font-family="DejaVu Sans" fill="#111">${word}</text></svg>`;
  return (await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64');
}
const WORDS = ['MELON', 'WALNUT', 'RIVET'];
const [A, B, C] = await Promise.all([wordImg('MELON', '#e8e0c8'), wordImg('WALNUT', '#cfe0ee'), wordImg('RIVET', '#e8d0d0')]);
const img = (d) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: d } });
const hit = (t) => WORDS.filter((w) => new RegExp(w, 'i').test(t)).length;

// ── ① 真通路：跨消息三张图（08-28 那个"不点名就必挂"的形状，现在留着当回归） ──
const { baseUrl } = await getOrStartIngress();
registerIngressSession('mergevendor-session', APP);
const url = `${baseUrl}/__nd/mergevendor-session/v1/messages`;
const body = {
  model: resolveModelRoute(APP).sdkAlias, max_tokens: 300,
  messages: [
    { role: 'user', content: [{ type: 'text', text: '第一张：' }, img(A)] },
    { role: 'assistant', content: [{ type: 'text', text: '收到。' }] },
    { role: 'user', content: [{ type: 'text', text: '第二张：' }, img(B)] },
    { role: 'assistant', content: [{ type: 'text', text: '收到。' }] },
    { role: 'user', content: [{ type: 'text', text: '三张图里的英文单词分别是什么？只回三个词' }, img(C)] },
  ],
};
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
console.log(`\n① 真通路多图：全认 ${ok}/${N}   瞎图 ${blind}   报错 ${err}`);
await stopIngress();

// ── ② 直连网关：谁在服务，有没有落到贵 10 倍那家 ──
const KEY = process.env.NODESIGN_UPSTREAM_MERGE_KEY;
const dist = {};
if (KEY) {
  for (let i = 0; i < N; i++) {
    const r = await fetch('https://api-gateway.merge.dev/v1/chat/completions', {
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
if (toParticle) console.log('⛔ 有请求落到 particle —— agent 循环里它会跑偏，zai 该排第一');
process.exit(blind > 0 || err > 0 || toBaseten || toParticle ? 1 : 0);
