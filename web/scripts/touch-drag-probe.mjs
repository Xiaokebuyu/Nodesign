/**
 * 触屏拖卡的攻击探针 —— 专打 2026-08-21 那个病（2026-08-29）
 *
 *   node web/scripts/touch-drag-probe.mjs <projectId> [--base=…]
 *
 * ## 为什么要单独写一个
 *
 * 要验的那条闸是「**第二根手指落下 → 卡弹回原位且不落盘**」，而这条路上有两个
 * 地方只认真事件：
 *   - useTouchGestures 的 onDown 第一句就是 `if (!e.isTrusted) return`
 *   - 于是合成 PointerEvent 根本进不了捏合分支，也就补不出那条 pointercancel
 *
 * ⭐ 所以**页面里 dispatchEvent 是验不了这条闸的** —— 它会一路绿灯然后什么都没测到，
 * 正是「假判据比没有更坏」。只能走 CDP 的 Input.dispatchTouchEvent，它发的是真事件。
 *
 * ## 三个场次
 *
 *   1. 长按 → 拖 → 松手      期望：卡挪了 **且** 有 PATCH（拖卡真的能用）
 *   2. 长按 → 拖 → 第二根手指 期望：卡回原位 **且** 零 PATCH（08-21 那个病）
 *   3. 不长按，直接滑         期望：卡不动、零 PATCH（滑一下是推画面）
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium, devices } = createRequire(import.meta.url)(path.join(ROOT, 'node_modules/playwright/index.js'));

const args = process.argv.slice(2);
const PID = args.find((a) => !a.startsWith('--'));
const opt = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).slice(n.length + 3);
const BASE = opt('base', 'https://nodesign.xiaobuyu.trade:8443');
if (!PID) { console.error('要给 projectId'); process.exit(1); }

const env = readFileSync(path.join(ROOT, '.env'), 'utf8');
const pw = /^NODESIGN_AUTH_PASSWORD=(.*)$/m.exec(env)?.[1];
const port = /^PORT=(.*)$/m.exec(env)?.[1] || '4002';
const res = await fetch(`http://localhost:${port}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: pw }),
});
const token = /nd_auth=([^;]+)/.exec(res.headers.get('set-cookie') || '')?.[1];

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
await ctx.addCookies([{ name: 'nd_auth', value: token, url: BASE }]);
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);

const writes = [];
page.on('request', (r) => {
  if (r.method() !== 'GET' && /\/board/.test(r.url())) writes.push(`${r.method()} ${r.url().split('/api')[1]}`);
});

await page.goto(`${BASE}/projects/${PID}/work`, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(6000);

/**
 * 挑一件**能拖的**：板书（text:/notes 那些）按设计就不给拖，拿它当靶子会得到
 * 一个"拖卡没生效"的假阴性 —— 第一版就栽在这儿，两个项目的头一件都是板书。
 */
const findTarget = () => page.evaluate(() => {
  const all = [...document.querySelectorAll('[data-board-object]')];
  const el = all.find((n) => {
    const id = n.getAttribute('data-board-object') || '';
    if (id.startsWith('text:') || id.includes('/板书/')) return false;
    // ⚠️ 还得**真在屏幕上**：第二版栽在这儿 —— 挑中了一件世界坐标 -1808 的卡，
    // 手指戳的其实是空地，报出来是"拖卡没生效"，跟真的没生效长得一模一样。
    const r = n.getBoundingClientRect();
    return r.width > 14 && r.height > 14 && r.left > 8 && r.top > 60
      && r.right < window.innerWidth - 8 && r.bottom < window.innerHeight - 90;
  });
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { id: el.getAttribute('data-board-object'), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
});
/**
 * 开局镜头对准的是「最近写出来的那件」，而那常常是块板书（不给拖）。所以用
 * 翻页器一件件往下翻，翻到一件能拖又在屏上的为止 —— 顺带也把翻页器走了一遍。
 */
let target = await findTarget();
if (!target) {
  // 开局镜头对准的是阅读序最后一件，那常常是块板书（不给拖）。先「全部入镜」把
  // 整块板收进屏幕，能拖的那几件就都在视野里了。
  const fit = await page.$('[data-tool-btn="fit"]');
  if (fit) { await fit.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(900); }
  target = await findTarget();
}
if (!target) { console.log(JSON.stringify({ error: '整块板上没有可拖的物件（全是板书）' })); await browser.close(); process.exit(0); }
console.log(`靶子：${target.id} @ 屏幕(${target.x},${target.y})`);

const posOf = (id) => page.evaluate(async (oid) => {
  const r = await fetch(`/api/projects/${location.pathname.split('/')[2]}/board`).then((x) => x.json());
  const o = r.board.objects[oid];
  return o ? { x: o.x, y: o.y } : null;
}, id);

const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })),
});

async function scene(name, run) {
  writes.length = 0;
  const before = await posOf(target.id);
  await run();
  await page.waitForTimeout(2200);          // 落盘是节流的，等它一拍
  const after = await posOf(target.id);
  const moved = before && after && (Math.abs(after.x - before.x) + Math.abs(after.y - before.y)) > 4;
  console.log(`${name}\n  卡: (${before?.x},${before?.y}) → (${after?.x},${after?.y})  挪了:${moved ? '是' : '否'}  写盘:${writes.length} ${writes.slice(0, 2).join(' ')}`);
  return { moved, writes: writes.length };
}

const P = (dx = 0, dy = 0) => ({ x: target.x + dx, y: target.y + dy });

const r1 = await scene('① 长按 → 拖 → 松手（期望：挪了 + 有写盘）', async () => {
  await touch('touchStart', [P()]);
  await page.waitForTimeout(600);           // 过长按门槛
  for (let i = 1; i <= 6; i += 1) { await touch('touchMove', [P(i * 12, i * 10)]); await page.waitForTimeout(30); }
  await touch('touchEnd', []);
});

const r2 = await scene('② 长按 → 拖 → 第二根手指（期望：回原位 + 零写盘）', async () => {
  await touch('touchStart', [P()]);
  await page.waitForTimeout(600);
  for (let i = 1; i <= 4; i += 1) { await touch('touchMove', [P(i * 14, i * 12)]); await page.waitForTimeout(30); }
  await touch('touchStart', [P(56, 48), P(-60, 60)]);   // 第二根手指落下
  await page.waitForTimeout(120);
  await touch('touchMove', [P(70, 60), P(-90, 90)]);    // 捏一下
  await touch('touchEnd', []);
});

const r3 = await scene('③ 不长按，直接滑（期望：不动 + 零写盘）', async () => {
  await touch('touchStart', [P()]);
  for (let i = 1; i <= 6; i += 1) { await touch('touchMove', [P(i * 14, i * 10)]); await page.waitForTimeout(20); }
  await touch('touchEnd', []);
});

const verdict = [
  r1.moved && r1.writes > 0 ? '✅ 拖卡能用' : '❌ 拖卡没生效',
  !r2.moved && r2.writes === 0 ? '✅ 捏合不带跑（08-21 那个病没了）' : '❌ 捏合还是把卡带跑/落盘了',
  !r3.moved && r3.writes === 0 ? '✅ 滑一下仍然是推画面' : '❌ 没长按也把卡挪了',
];
console.log('\n' + verdict.join('\n'));
await browser.close();
process.exit(verdict.some((v) => v.startsWith('❌')) ? 1 : 0);
