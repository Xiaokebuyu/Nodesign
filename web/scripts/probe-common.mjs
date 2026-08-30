/**
 * 探针的公共起手式（2026-08-30）—— 「怎么开一个真能看见这个站点的浏览器」只写一份。
 *
 * 这个文件是被一整天的浪费逼出来的。做首页光源层那轮，**量具出的错比被测的
 * 代码还多**，而且每一次都指着一个不存在的 bug：
 *
 *   ⛔ 截图里 WebGL 画布是空的  → 去查合成、改 alpha 口径、翻驱动，全白忙。
 *      真因是 headless 默认渲染器拍不到被 CSS 放大的 fixed 画布，
 *      差 `--use-angle=swiftshader --enable-unsafe-swiftshader`。
 *   ⛔ 有的截图中文有的英文     → 没钉 locale，playwright 默认 en-US，
 *      站点跟着走。两张图连内容都不是同一份，还拿去做 A/B。
 *   ⛔ 同一页两次截图文案不一样 → 输入框的示例句在轮播，差异图里全是鬼影。
 *   ⛔ 夜晚模式"看着没生效"     → 均值 212 → 168，其实暗得离谱。
 *      **预览通道会归一化，一整张都变暗时它看起来跟没变一样。**
 *
 * 所以这里定了三条纪律，谁用这个模块谁自动带上：
 *   1. 起浏览器一律带 LAUNCH_ARGS（WebGL 拍得到）
 *   2. 会变的东西一律钉死：locale、时钟、Math.random
 *   3. **截图一律同时给数字**（statLine）—— 亮度判断不许只靠眼睛看预览
 *
 * ⚠️ shot-auth.mjs 故意没接进来：它是登录墙的逐像素守门，换启动参数会让既有
 * 基线全废，而那面墙上没有 canvas，本来就吃不到这里的好处。
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const req = createRequire(import.meta.url);
export const { chromium, devices } = req(path.join(ROOT, 'node_modules/playwright/index.js'));
export const sharp = req(path.join(ROOT, 'node_modules/sharp'));

/**
 * ⭐ 起浏览器的参数。**别删后面三个。**
 *
 * headless 默认那条渲染路径拍不到 `position:fixed` + CSS 放大的 WebGL 画布：
 * 页面上看得见（用 CSS 背景染个色能证明元素在画），截图里那一层就是没有。
 * 换成 ANGLE 的 swiftshader 之后最小用例才拍得到。
 *
 * ⚠️ 而且这条**最小用例和真页面会给出相反的结论** —— 真页面加不加都能拍到。
 * 所以别因为"我这次不加也行"就删掉：下一个靶子未必。lens.mjs selftest
 * 里有一条 canary 专门验这个。
 */
export const LAUNCH_ARGS = [
  '--no-sandbox',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-gpu-sandbox',
];

/** 站点入口。默认 exp（8443），跟 shot-live.mjs 一致 —— 改生产要显式给 */
export const DEFAULT_BASE = process.env.ND_BASE || 'https://nodesign.xiaobuyu.trade:8443';

function authPassword() {
  if (process.env.ND_PASSWORD) return process.env.ND_PASSWORD;
  try {
    const env = readFileSync(path.join(ROOT, '.env'), 'utf8');
    return (env.match(/^NODESIGN_AUTH_PASSWORD=(.*)$/m) || [])[1]?.trim() || null;
  } catch { return null; }
}

/**
 * 开一个探针会话。
 *
 * @param {object} o
 * @param {string} [o.base]     入口
 * @param {string} [o.viewport] '1440x900'
 * @param {number} [o.dsf]      设备像素比
 * @param {string} [o.locale]   'zh-CN'（默认）| 'en'
 * @param {string} [o.at]       钉死的时刻，'2026-08-30T13:00:00' 或 '13:00'
 * @param {string} [o.device]   playwright 设备名（真触屏模拟，见 shot-live.mjs 的教训）
 * @param {boolean} [o.login]   是否以 admin 登录（默认 true）
 * @param {boolean|number} [o.freeze] 画够几帧就掐掉 rAF，把动画层定住（比差异的判据必须开）
 */
export async function openProbe(o = {}) {
  const base = o.base || DEFAULT_BASE;
  const [vw, vh] = (o.viewport || '1440x900').split('x').map(Number);
  const locale = o.locale === 'en' ? 'en' : 'zh-CN';
  const browser = await chromium.launch({ args: LAUNCH_ARGS });
  const ctx = await browser.newContext({
    ...(o.device && devices[o.device] ? devices[o.device] : {}),
    viewport: { width: vw, height: vh },
    deviceScaleFactor: o.dsf || 1,
    ignoreHTTPSErrors: true,
    locale: locale === 'en' ? 'en-US' : 'zh-CN',
    reducedMotion: o.reducedMotion,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  // ⭐ 界面语言钉死。不钉的话 playwright 默认 en-US，站点跟着走 ——
  // 同一轮里有的图中文有的英文，A/B 直接作废（踩过）。
  await page.addInitScript((loc) => {
    try { localStorage.setItem('nd:locale', loc); } catch { /* 隐私模式 */ }
  }, locale);
  // ⭐ 随机数钉死：首页输入框的示例句是随机挑的，不钉的话两张图连文案都不一样，
  // 差异图里全是鬼影。种子固定 = 同一次运行内每次都拿到同一句。
  await page.addInitScript(() => {
    let s = 0x2f6e2b1;
    Math.random = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  });
  if (o.at) await ctx.clock.setFixedTime(atDate(o.at));

  /**
   * ⭐⭐ 把会自己动的那一层定住（`freeze: true`）。
   *
   * 首页的光源层是活的 WebGL。任何「拍两张、比差异」的判据 —— 对比度探针靠
   * "这一格因为字没了才变" 认笔画 —— 都会把**飘过去的光斑**当成笔画：
   * 08-30 量左栏那几行字，量出 1.01:1，而截图里字清清楚楚。定住之后是 2.07:1。
   *
   * ⚠️ 不能用 `clock` 定：那只冻 Date/定时器，rAF 照跑。画够几帧再掐 rAF，
   * 这样层已经画出来了（不是空白），但从此不再动。
   */
  if (o.freeze) {
    await page.addInitScript((n) => {
      const raf = window.requestAnimationFrame.bind(window);
      let left = n;
      window.requestAnimationFrame = (cb) => (left-- > 0 ? raf(cb) : 0);
    }, typeof o.freeze === 'number' ? o.freeze : 8);
  }

  if (o.login !== false) {
    const pw = authPassword();
    if (!pw) throw new Error('拿不到 NODESIGN_AUTH_PASSWORD（.env 或 ND_PASSWORD）');
    await page.request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: pw } });
    await ctx.addCookies((await page.request.storageState()).cookies);
  }

  return {
    browser, ctx, page, errors, base, locale,
    async goto(route = '/', wait = 2500) {
      await page.goto(base + route, { waitUntil: 'networkidle' });
      await page.waitForTimeout(wait);
    },
    // ⚠️ 超时放到 90s：这台是 1 vCPU，页面上有 WebGL 层时 headless 走的是
    // SwiftShader（CPU 在模拟 GPU），再赶上同机在跑测试，单张截图能超过默认的 30s。
    // 截图超时报出来的样子跟"页面坏了"很像，别把它当 bug 查。
    shot: (opts) => page.screenshot({ timeout: 90_000, ...opts }),
    async close() { await browser.close(); },
  };
}

/** '13:00' → 今天 13 点；完整 ISO 原样用 */
export function atDate(s) {
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const d = new Date();
    const [h, m] = s.split(':').map(Number);
    d.setHours(h, m, 0, 0);
    return d;
  }
  return new Date(s);
}

/**
 * ⭐⭐ 一张图的数字。**任何亮度/对比的判断都要读这个，不许只看预览** ——
 * 预览通道会归一化，整张变暗时它看起来跟没变一样（夜晚模式那次就是这么误判的）。
 */
export async function pixelStats(buf) {
  const st = await sharp(buf).stats();
  const [r, g, b] = st.channels;
  return {
    mean: [r.mean, g.mean, b.mean],
    stdev: [r.stdev, g.stdev, b.stdev],
    min: Math.min(r.min, g.min, b.min),
    max: Math.max(r.max, g.max, b.max),
  };
}

export async function statLine(buf, tag = '') {
  const s = await pixelStats(buf);
  return `${tag ? tag.padEnd(10) : ''}均值 ${s.mean.map((v) => v.toFixed(1)).join('/')}`
    + `  标准差 ${s.stdev[0].toFixed(1)}  区间 ${s.min}–${s.max}`;
}

/**
 * 页面渲染成没成，先断言再测。
 *
 * ⛔ 这一条是拿三轮废数据换来的：页面被一个反引号炸成白屏，而 trace 照样
 * 吐出漂亮的数字。「跑过了」和「测到了」是两件事。
 *
 * @param {object} lens openProbe 的返回
 * @param {object} need { selector: 最少几个 } —— 比如 { '.ndd-card': 1 }
 */
export async function assertRendered(lens, need = {}) {
  if (lens.errors.length) throw new Error(`页面有报错，数据作废：${lens.errors[0]}`);
  const counts = await lens.page.evaluate(
    (sels) => Object.fromEntries(sels.map((s) => [s, document.querySelectorAll(s).length])),
    Object.keys(need),
  );
  for (const [sel, min] of Object.entries(need)) {
    if ((counts[sel] || 0) < min) throw new Error(`页面没渲染好：${sel} 只有 ${counts[sel] || 0} 个（要 ≥${min}），数据作废`);
  }
  return counts;
}

/**
 * 把几张图拼成一张，每格左下角贴标签。
 *
 * ⭐ 观感判断一律看这个，不看单张：**同一张图里的相对差是可信的**，
 * 而单张图的绝对亮度不可信。
 */
export async function contactSheet(tiles, { cols = 2, gap = 8, bg = '#555' } = {}) {
  const metas = await Promise.all(tiles.map((t) => sharp(t.buf).metadata()));
  const w = Math.max(...metas.map((m) => m.width));
  const h = Math.max(...metas.map((m) => m.height));
  const labelled = await Promise.all(tiles.map(async (t, i) => {
    const svg = `<svg width="${metas[i].width}" height="24"><rect width="${8 + t.label.length * 9}" height="20" fill="#fff"/>`
      + `<text x="5" y="15" font-family="monospace" font-size="13" fill="#000">${t.label}</text></svg>`;
    return sharp(t.buf).composite([{ input: Buffer.from(svg), top: metas[i].height - 24, left: 0 }]).png().toBuffer();
  }));
  const rows = Math.ceil(labelled.length / cols);
  return sharp({ create: { width: w * cols + gap * (cols + 1), height: h * rows + gap * (rows + 1), channels: 3, background: bg } })
    .composite(labelled.map((input, i) => ({
      input, left: gap + (i % cols) * (w + gap), top: gap + Math.floor(i / cols) * (h + gap),
    })))
    .png().toBuffer();
}
