/**
 * 登录墙的像素守门（2026-08-29 重建）。
 *
 * 08-03 换肤那轮有过一套（`shotauth.mjs` + `sp.png`，逐像素 diff 要求 0），但它
 * 从来没入仓，盒上早就没有了。现在要给登录墙包 146 条 t()，正需要这条回归线：
 * **中文用户看到的东西，改完之后一个字节都不许变。**
 *
 * ## 怎么让一面会动的墙可以截图
 *
 * 登录墙是定格轮播，本来每 10 秒换一套。不去劫持时钟 —— 产品自己就有一条确定性
 * 通道：`prefers-reduced-motion: reduce` 时轮播**整套机制不启动**（连定时器都不装），
 * 停在第一套。所以 launch 时开 reducedMotion，再叠 screenshot 的 animations:'disabled'
 * 收掉 CSS 动画。⭐ 用产品自己的开关，不用探针专属的后门 —— 后门会跟真行为漂移。
 *
 * ## 用法
 *   node web/scripts/shot-auth.mjs --baseline     # 立基线（改动前跑）
 *   node web/scripts/shot-auth.mjs                # 比对（改动后跑，要求 0 像素差）
 *   node web/scripts/shot-auth.mjs --locale en    # 看英文版长什么样（另存一套）
 *
 * 需要 dev server：cd web && npx vite --port 5199
 *
 * ⚠️ 基线**不入仓**（__baseline__/ 已进 .gitignore）：三张 PNG 就是好几 MB，而它的
 * 用法是「改之前 --baseline，改之后比一次」，是一次改动内的 A/B，不是跨会话的
 * 金样本套件。要跨会话守，得先解决图存哪儿的问题。
 */
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pkg from 'playwright';
import sharp from 'sharp';

const { chromium } = pkg;
const HERE = import.meta.dirname;
const DIR = path.join(HERE, '__baseline__');
const args = process.argv.slice(2);
const WRITE = args.includes('--baseline');
const LOCALE = args.includes('--locale') ? args[args.indexOf('--locale') + 1] : 'zh-CN';
const URL = args.find((a) => a.startsWith('http')) || 'http://localhost:5199/';

/** 三个视口：宽屏 / 窄桌面（工具栏折行的那个档）/ 手机 */
const SHOTS = [
  // dsf 都取 1：这是**版面**守门不是渲染质量守门，1x 已经能逮住位移/换行/字体回退，
  // 2x 的基线三张加起来 16MB，盘上 88% 满，不值。
  { name: 'wide', width: 1920, height: 930, dsf: 1 },
  { name: 'narrow', width: 1100, height: 860, dsf: 1 },
  { name: 'phone', width: 390, height: 844, dsf: 1 },
];

mkdirSync(DIR, { recursive: true });
const browser = await chromium.launch();
let bad = 0;

for (const s of SHOTS) {
  const ctx = await browser.newContext({
    viewport: { width: s.width, height: s.height },
    deviceScaleFactor: s.dsf,
    // 产品自己的确定性通道：轮播停在第一套，定时器一个都不装
    reducedMotion: 'reduce',
    locale: LOCALE === 'en' ? 'en-US' : 'zh-CN',
  });
  // ⭐ 把日期钉死（2026-08-29 季节皮肤上线后加的）。
  //
  // 站点的纸和板面现在跟着季节走（lib/season.js），基线要是按"跑测试那天"截，
  // **每换一季这条守门线就自己废一次** —— 报出来 80% 像素不同，而实际上什么都没坏。
  // 钉在冬天：那一季还没做皮肤，落回基线值，是最稳的参照。
  // ⚠️ 哪天冬季皮肤做出来了，这里要改成每季各存一张基线，否则又会漂。
  await ctx.clock.setFixedTime(new Date('2026-12-15T10:00:00'));
  const page = await ctx.newPage();
  await page.addInitScript((loc) => {
    try { localStorage.setItem('nd:locale', loc); } catch { /* 隐私模式 */ }
  }, LOCALE);
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(900);   // 字体换上去 + 第一套站稳

  const buf = await page.screenshot({ animations: 'disabled' });
  const tag = LOCALE === 'zh-CN' ? s.name : `${s.name}.${LOCALE}`;
  const ref = path.join(DIR, `auth-${tag}.png`);

  if (WRITE || !existsSync(ref)) {
    writeFileSync(ref, buf);
    console.log(`  立基线 ${path.basename(ref)}  ${(buf.length / 1024).toFixed(0)}KB`);
  } else {
    const [a, b] = await Promise.all([
      sharp(ref).raw().toBuffer({ resolveWithObject: true }),
      sharp(buf).raw().toBuffer({ resolveWithObject: true }),
    ]);
    if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
      console.log(`  ⛔ ${tag}: 尺寸变了 ${a.info.width}x${a.info.height} → ${b.info.width}x${b.info.height}`);
      bad += 1;
    } else {
      let diff = 0;
      for (let i = 0; i < a.data.length; i += a.info.channels) {
        if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) diff += 1;
      }
      const total = a.info.width * a.info.height;
      if (diff) {
        const actual = path.join(DIR, `auth-${tag}.actual.png`);
        writeFileSync(actual, buf);
        console.log(`  ⛔ ${tag}: ${diff} 像素不同（${(diff / total * 100).toFixed(3)}%）→ ${path.basename(actual)}`);
        bad += 1;
      } else {
        console.log(`  ✅ ${tag}: 0 像素差`);
      }
    }
  }
  await ctx.close();
}

await browser.close();
console.log(bad ? `\n⛔ ${bad}/${SHOTS.length} 个视口变了` : `\n✅ 登录墙没动（${LOCALE}）`);
process.exit(bad ? 1 : 0);
