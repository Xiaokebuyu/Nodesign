/**
 * 真浏览器验一遍两级字集（2026-08-29 混排案）。
 *
 * 判据不是「document.fonts 里有没有这个 face」—— 那只说明声明在，不说明那个字
 * 真用上了。这里逐字对撞：同一个字，一次用 FONT_KAI 那条栈画，一次用纯 serif 画，
 * 像素相同 = 它退回系统宋体了（就是那个 bug），不同 = 楷体真的接住了。
 *
 * 用法（先起 dev server：cd web && npx vite --port 5199）：
 *   node web/scripts/font-probe.mjs [url]
 *   node web/scripts/font-probe.mjs --shot <出图路径>   # 顺带出一张修前修后对照图
 */
import pkg from 'playwright';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const { chromium } = pkg;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const shotAt = args.includes('--shot') ? args[args.indexOf('--shot') + 1] : null;
const URL = args.find(a => a.startsWith('http')) || 'http://localhost:5199/';

const CHARS = [
  ['文', '首屏字集'],
  ['腾', '全站字集（08-29 新切）'],
  ['囧', '两级都没有 → 该由 Screen 兜住'],
  ['鬻', '两级都没有 → 该由 Screen 兜住'],
];
const KAI = "'LXGW WenKai ND', 'LXGW WenKai', '霞鹜文楷', 'LXGW WenKai Screen', serif";
// 首页上真实的一段话，用来出修前/修后对照图
const SAMPLE = '这个月花了 $4.10 · 在做 演示 deck · 已上线 3 件 · 腾讯会议 · 检查清单';

/** 首屏字集真实覆盖的码位（修好之前，只有这些字能落在楷体上） */
const firstRange = new Set(JSON.parse(execFileSync('python3', [
  resolve(ROOT, 'web/scripts/gen-font-subset.py'), '--report',
], { encoding: 'utf8', cwd: ROOT })).firstRange
  .split(',')
  .flatMap((r) => {
    const [a, b] = r.replace(/U\+/g, '').split('-').map(h => parseInt(h, 16));
    return Array.from({ length: (b ?? a) - a + 1 }, (_, i) => a + i);
  }));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 460 }, deviceScaleFactor: 2 });
await page.goto(URL, { waitUntil: 'networkidle' });

await page.evaluate(({ chars, kai }) => {
  const host = document.createElement('div');
  host.id = 'font-probe';
  host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#fff;font-size:80px;line-height:1.4';
  host.innerHTML = chars.map(([c], i) => `
    <span id="k${i}" style="font-family:${kai}">${c}</span>
    <span id="s${i}" style="font-family:serif">${c}</span>`).join('<br>');
  document.body.appendChild(host);
}, { chars: CHARS, kai: KAI });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(600);

const rows = [];
for (let i = 0; i < CHARS.length; i += 1) {
  const a = await page.locator(`#k${i}`).screenshot();
  const b = await page.locator(`#s${i}`).screenshot();
  rows.push({ ch: CHARS[i][0], note: CHARS[i][1], same: Buffer.compare(a, b) === 0 });
}
console.log('\n=== 逐字对撞（same=true 就是退回系统宋体了）===');
for (const r of rows) console.log(`  ${r.ch}  退回serif=${String(r.same).padEnd(5)}  ${r.note}`);

if (shotAt) {
  // 修好之前 = 首屏字集里没有的字逐个掉去 serif（CSS 的回退是逐字的，就长这样）
  await page.evaluate(({ sample, kai, cps }) => {
    const has = new Set(cps);
    const before = [...sample].map(c => (has.has(c.codePointAt(0))
      ? c : `<span style="font-family:serif">${c}</span>`)).join('');
    document.getElementById('font-probe').innerHTML = `
      <div style="padding:36px 40px;font-size:15px;color:#8a7355;font-family:${kai}">修好之前（首屏字集之外的字逐个掉去系统宋体）</div>
      <div style="padding:0 40px 34px;font-size:34px;font-family:${kai}">${before}</div>
      <div style="padding:0 40px 8px;font-size:15px;color:#8a7355;font-family:${kai}">修好之后（两级字集 + Screen 兜底）</div>
      <div style="padding:0 40px;font-size:34px;font-family:${kai}">${sample}</div>`;
  }, { sample: SAMPLE, kai: KAI, cps: [...firstRange] });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.locator('#font-probe').screenshot({ path: shotAt });
  console.log(`\n对照图：${shotAt}`);
}

await browser.close();
const bad = rows.filter(r => r.same);
console.log(bad.length ? `\n⛔ 还有 ${bad.length} 个字在退回宋体：${bad.map(r => r.ch).join('')}` : '\n✅ 四个字都没有退回宋体');
process.exit(bad.length ? 1 : 0);
