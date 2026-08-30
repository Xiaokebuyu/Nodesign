/**
 * 镜头 —— 看页面「几个状态并排是什么样」的量具（2026-08-30）。
 *
 * shot-live.mjs 回答「这一屏长什么样」；这个回答另外三种问题，都是单张截图
 * 天然答不了的：
 *
 *   sheet   几个状态并排（一天四个时刻 / 三档模式 / 几个视口）拼成**一张**图
 *   ab      某一层开和关，差在哪、差多少、差在哪个框里
 *   perf    某一层的开销，**按线程分账**
 *   contrast 最暗那几块上的字还读不读得动（WCAG 对比度）
 *   selftest 这把尺子自己准不准
 *
 * ## ⭐⭐ 为什么非要拼成一张
 *
 * 做首页光源层那轮，夜晚模式我连着看了四五张截图都判「几乎没生效」，于是去查
 * 合成、改 alpha 口径、加启动参数 —— 全是白忙。真去读像素：**白天均值 212、
 * 夜里 168**，差别大得离谱。预览通道会做归一化，**一整张都变暗时它看起来跟
 * 没变一样**。
 *
 * 结论有两条，这个文件把它们变成默认行为：
 *   1. 观感判断看接触印相（同一张图里的相对差可信），不看单张
 *   2. **每一张都同时打数字**，亮度的话头一律以数字为准
 *
 * ## ⭐ A/B 要先把「自己会动的像素」剔掉
 *
 * 第一次做光源层的 A/B，差异图里全是鬼影：输入框的示例句在轮播、locale 还
 * 没钉、封面图会重生成。**活数据比没数据更坏** —— 它让你以为那一层影响了整页。
 * 这里的做法是先在「关」的状态下连拍两张求出会自己动的像素，把它们从判据里挖掉。
 *
 * ## 用法
 *
 *   node web/scripts/lens.mjs sheet --at=09:00,13:00,18:00,22:00 --out=/tmp/day.png
 *   node web/scripts/lens.mjs sheet --mode=auto,day,night --require=.ndd-card
 *   node web/scripts/lens.mjs ab --hide=.ndd-canopy --at=13:00 --out=/tmp/ab.png
 *   node web/scripts/lens.mjs perf --toggle=.ndd-canopy --at=13:00
 *   node web/scripts/lens.mjs contrast --at=22:00 --on=选择器 --top=20
 *   node web/scripts/lens.mjs selftest
 *
 * 公共选项：--base= --route= --viewport=1440x900 --dsf=1 --locale=zh-CN
 *          --crop=x,y,w,h --wait=2500 --require=选择器（渲染没渲染好的断言）
 *
 * ⚠️ 默认入口是 exp（8443）。要看生产得显式 `--base=https://nodesign.xiaobuyu.trade`。
 */
import { writeFileSync } from 'node:fs';
import {
  openProbe, assertRendered, contactSheet, statLine, pixelStats, sharp, atDate, DEFAULT_BASE,
} from './probe-common.mjs';

const argv = process.argv.slice(2);
const MODE = argv.find((a) => !a.startsWith('--')) || 'sheet';
const opt = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const list = (n, d) => opt(n, d).split(',').filter(Boolean);

const BASE = opt('base', DEFAULT_BASE);
const ROUTE = opt('route', '/');
const VIEWPORT = opt('viewport', '1440x900');
const DSF = Number(opt('dsf', '1'));
const LOCALE = opt('locale', 'zh-CN');
const WAIT = Number(opt('wait', '2500'));
const OUT = opt('out', '/tmp/lens.png');
const CROP = opt('crop', null);
const REQUIRE = list('require', '');

const clip = CROP ? (([x, y, width, height]) => ({ x, y, width, height }))(CROP.split(',').map(Number)) : undefined;
const need = Object.fromEntries(REQUIRE.map((s) => [s, 1]));

const open = (extra = {}) => openProbe({
  base: BASE, viewport: VIEWPORT, dsf: DSF, locale: LOCALE, ...extra,
});

// ─────────────────────────────────────────────────────────────
// sheet —— 几个状态拼成一张
// ─────────────────────────────────────────────────────────────
async function sheet() {
  const ats = list('at', '');
  const modes = list('mode', '');
  // 一次只走一根轴：时刻或模式。两根一起是笛卡尔积，图会大到没法看。
  const states = ats.length ? ats.map((at) => ({ at, label: at }))
    : modes.length ? modes.map((m) => ({ dayMode: m, label: m }))
      : [{ label: '现状' }];

  const lens = await open({ at: states[0].at });
  const tiles = [];
  try {
    for (const s of states) {
      // ⚠️ 时钟是 context 级的，改完必须重新加载 —— 页面在模块加载时读过一次日期
      if (s.at) await lens.ctx.clock.setFixedTime(atDate(s.at));
      if (s.dayMode) {
        await lens.page.addInitScript((m) => {
          try { localStorage.setItem('nd:daylight', m); } catch { /* 隐私模式 */ }
        }, s.dayMode);
      }
      await lens.goto(ROUTE, WAIT);
      if (REQUIRE.length) await assertRendered(lens, need);
      const buf = await lens.shot({ clip });
      tiles.push({ buf, label: s.label });
      console.log(await statLine(buf, s.label));
    }
    writeFileSync(OUT, await contactSheet(tiles, { cols: tiles.length > 2 ? 2 : tiles.length }));
    console.log(`\n→ ${OUT}（${tiles.length} 格）`);
    console.log('⭐ 判观感看这张拼图，别看单张 —— 单张的绝对亮度预览会归一化。');
  } finally { await lens.close(); }
}

// ─────────────────────────────────────────────────────────────
// ab —— 某一层开/关，差在哪
// ─────────────────────────────────────────────────────────────
const setDisplay = (page, sel, v) => page.evaluate(
  ([s, d]) => { document.querySelectorAll(s).forEach((e) => { e.style.display = d; }); },
  [sel, v],
);

async function ab() {
  const sel = opt('hide', null);
  if (!sel) throw new Error('ab 要 --hide=<选择器>');
  const lens = await open({ at: opt('at', null) });
  try {
    await lens.goto(ROUTE, WAIT);
    if (REQUIRE.length) await assertRendered(lens, need);

    // ⭐ 先在「关」的状态连拍两张，求出**自己会动的像素**（轮播文案、活预览、
    // 封面重生成……）。不剔掉的话差异图全是鬼影，会让人以为这一层影响了整页。
    await setDisplay(lens.page, sel, 'none');
    await lens.page.waitForTimeout(700);
    const off1 = await lens.shot({ clip });
    await lens.page.waitForTimeout(900);
    const off2 = await lens.shot({ clip });
    // 同一次加载里开回来，内容不会再变
    await setDisplay(lens.page, sel, '');
    await lens.page.waitForTimeout(900);
    const on = await lens.shot({ clip });

    const raw = (b) => sharp(b).raw().toBuffer({ resolveWithObject: true });
    const [A, B, C] = await Promise.all([raw(off1), raw(off2), raw(on)]);
    const { width: W, height: H, channels: CH } = C.info;
    const d3 = (p, q, i) => Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]);

    let live = 0, hit = 0, sum = 0, max = 0;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    const diff = Buffer.alloc(W * H * 3);
    for (let y = 0, i = 0, j = 0; y < H; y++) {
      for (let x = 0; x < W; x++, i += CH, j += 3) {
        const isLive = d3(A.data, B.data, i) > 6;      // 关着也在变 = 活像素
        const d = d3(B.data, C.data, i);
        if (isLive) { live++; diff[j] = 255; diff[j + 1] = 0; diff[j + 2] = 255; continue; }
        for (let k = 0; k < 3; k++) diff[j + k] = Math.min(255, 128 + (C.data[i + k] - B.data[i + k]) * 6);
        if (d > 6) {
          hit++; sum += d; if (d > max) max = d;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    const tot = W * H;
    writeFileSync(OUT, await sharp(diff, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer());
    console.log(await statLine(off2, '关'));
    console.log(await statLine(on, '开'));
    console.log(`\n活像素（关着也在动，已剔除）: ${(live / tot * 100).toFixed(2)}%`);
    console.log(`这一层改变了 ${(hit / tot * 100).toFixed(1)}% 的像素，平均色差 ${(sum / Math.max(hit, 1)).toFixed(1)}，最大 ${max}`);
    // ⭐ 判据看包围盒不是百分比：一个"只差 0.3%"但盒子铺满全屏的改动，
    // 跟一个"差 0.3%"但缩在角落的改动，是两件完全不同的事。
    console.log(hit ? `差异包围盒 ${x0},${y0} → ${x1},${y1}（${x1 - x0 + 1}×${y1 - y0 + 1}，占画面 ${((x1 - x0 + 1) * (y1 - y0 + 1) / tot * 100).toFixed(0)}%）`
      : '⛔ 这一层开关没有任何可见差别 —— 先怀疑它压根没画上，别急着调参数');
    console.log(`→ ${OUT}（差异放大 6 倍；洋红 = 被剔掉的活像素）`);
  } finally { await lens.close(); }
}

// ─────────────────────────────────────────────────────────────
// perf —— 按线程分账
// ─────────────────────────────────────────────────────────────
async function perf() {
  const sel = opt('toggle', null);
  if (!sel) throw new Error('perf 要 --toggle=<选择器>');
  const lens = await open({ at: opt('at', null), dsf: DSF });
  try {
    await lens.goto(ROUTE, WAIT);
    if (REQUIRE.length) await assertRendered(lens, need);
    const cdp = await lens.ctx.newCDPSession(lens.page);

    const round = async (label, on) => {
      await setDisplay(lens.page, sel, on ? '' : 'none');
      await lens.page.waitForTimeout(800);
      await cdp.send('Tracing.start', { categories: 'disabled-by-default-devtools.timeline,devtools.timeline', transferMode: 'ReturnAsStream' });
      // 真滚一遍并**打印滚到了哪** —— 08-28 那次整轮数据作废就是因为页面压根没滚过
      const ys = [];
      for (const y of [700, 1600, 2600, 1400, 0]) {
        await lens.page.evaluate((v) => window.scrollTo(0, v), y);
        await lens.page.waitForTimeout(650);
        ys.push(await lens.page.evaluate(() => Math.round(window.scrollY)));
      }
      await lens.page.waitForTimeout(2400);
      const done = new Promise((r) => cdp.on('Tracing.tracingComplete', r));
      await cdp.send('Tracing.end');
      const { stream } = await done;
      let buf = '';
      for (;;) { const { data, eof } = await cdp.send('IO.read', { handle: stream }); buf += data; if (eof) break; }
      await cdp.send('IO.close', { handle: stream });
      const ev = JSON.parse(buf).traceEvents || [];
      // ⭐ 按线程分账。整份 trace 求和会把 headless 的 SwiftShader 在 CPU 上
      // 模拟 GPU 那笔算进来 —— 得出「净增 4.9 秒」这种吓人但没指向的数。
      // 卡不卡只取决于 CrRendererMain。
      const names = {};
      for (const e of ev) if (e.name === 'thread_name' && e.args?.name) names[`${e.pid}/${e.tid}`] = e.args.name;
      const by = {};
      for (const e of ev) if (e.name === 'RunTask' && e.dur) {
        const k = names[`${e.pid}/${e.tid}`] || `未知${e.tid}`;
        by[k] = (by[k] || 0) + e.dur / 1000;
      }
      const main = by.CrRendererMain || 0;
      const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(' ｜ ');
      const scrolled = ys.some((v) => v > 0);
      console.log(`${label.padEnd(6)} 主线程 ${main.toFixed(0).padStart(5)}ms   ${top}${scrolled ? '' : '   ⚠️ 页面没滚动过（可能滚的是内层容器），滚动那部分不算'}`);
      return main;
    };
    const off = await round('关', false);
    const on = await round('开', true);
    console.log(`\n主线程净增 ${(on - off).toFixed(0)}ms（关 ${off.toFixed(0)} → 开 ${on.toFixed(0)}）`);
    console.log('⚠️ headless 是 SwiftShader，GPU 那几个线程的数在真机上不成立；只有主线程这一列可比。');
  } finally { await lens.close(); }
}


// ─────────────────────────────────────────────────────────────
// contrast —— 压了一层暗之后，字还读不读得动
// ─────────────────────────────────────────────────────────────
/** sRGB 通道线性化（WCAG 2.x 的相对亮度） */
const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/**
 * ⭐ 「夜里太暗了」这句话没法调参 —— 得有个数。这里量的是**字对纸的 WCAG 对比度**。
 *
 * ⛔ 第一版是按亮度取分位数（最暗的 8% 当字、60% 当纸）。看着合理，**白天一量
 * 也是 1.13:1** —— 跟夜里的 1.15 几乎一样，等于什么都没量到：一个文字块里字只占
 * 一两成面积，抗锯齿之后落在"最暗 8%"里的全是纸的颗粒和笔画边缘，够不着笔画芯。
 * 拿一个已知好的状态（白天）去标定，是这条判据唯一被戳穿的方式。
 *
 * 现在的做法：**让页面自己告诉我哪些像素是字** —— 拍一张，再把这些元素的
 * `color` 设成透明拍第二张，两张的差集就是笔画。纸取第二张的中位数，字取
 * 笔画像素里偏暗的那一档。
 */
async function contrastMode() {
  const sel = opt('on', '.ndd-card .t, .ndd-card .m, .ndd-note');
  const floor = Number(opt('floor', '4.5'));   // WCAG AA 正文
  // ⭐ freeze：光源层是活的，不定住的话"因为字没了才变的像素"里会混进飘过去的
  //    光斑 —— 同一块字量出来 1.01:1（真值 2.07:1），而且**看着很像真的**。
  const lens = await open({ at: opt('at', '22:00'), freeze: true });
  try {
    await lens.goto(ROUTE, WAIT);
    if (REQUIRE.length) await assertRendered(lens, need);
    const boxes = await lens.page.evaluate((s) => [...document.querySelectorAll(s)]
      .map((e) => { const r = e.getBoundingClientRect(); return { tag: e.className || e.tagName, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })
      .filter((r) => r.w > 40 && r.h > 12 && r.x >= 0 && r.y >= 0 && r.x + r.w <= window.innerWidth && r.y + r.h <= window.innerHeight), sel);
    if (!boxes.length) throw new Error(`没找到可量的块（${sel}）—— 换个 --on= 或者先滚到能看见它们的位置`);

    const withText = await lens.shot();
    // ⭐ 让页面自己指出哪些像素是字：把字设成透明再拍一张，差集就是笔画。
    await lens.page.evaluate((s) => {
      const st = document.createElement('style');
      st.textContent = `${s} { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; }`;
      document.head.appendChild(st);
    }, sel);
    await lens.page.waitForTimeout(500);
    const noText = await lens.shot();

    const raw = (b) => sharp(b).raw().toBuffer({ resolveWithObject: true });
    const [S1, S2] = await Promise.all([raw(withText), raw(noText)]);
    const { width: W, channels: CH } = S1.info;
    const rows = [];
    for (const b of boxes) {
      const glyph = [], paper = [];
      for (let y = b.y; y < b.y + b.h; y++) {
        for (let x = b.x; x < b.x + b.w; x++) {
          const i = (y * W + x) * CH;
          const l1 = lum(S1.data[i], S1.data[i + 1], S1.data[i + 2]);
          const l2 = lum(S2.data[i], S2.data[i + 1], S2.data[i + 2]);
          paper.push(l2);
          const d = Math.abs(S1.data[i] - S2.data[i]) + Math.abs(S1.data[i + 1] - S2.data[i + 1]) + Math.abs(S1.data[i + 2] - S2.data[i + 2]);
          if (d > 24) glyph.push(l1);      // 这一格因为"字没了"而变了 → 它是笔画
        }
      }
      // 笔画太少说明这块根本没字（或者字没被那条 CSS 命中），不算数
      if (glyph.length < 25) continue;
      glyph.sort((p, q) => p - q); paper.sort((p, q) => p - q);
      const bg = paper[Math.floor(paper.length * 0.5)];
      /*
       * ⭐ 取笔画芯 = **离纸最远**的那一档，不是固定取最暗的一档。
       *
       * ⛔ 第一版写死 15 分位（"字比纸暗"）。08-30 做夜里的粉笔时当场翻车：
       *   板上是浅字压在暗底上，最暗的 15% 全是抗锯齿的边缘 —— 量出 1.10:1，
       *   而那时字已经改亮了、肉眼清清楚楚。**判据里藏着"深色字"这个前提。**
       */
      const lo = glyph[Math.floor(glyph.length * 0.15)];
      const hi = glyph[Math.floor(glyph.length * 0.85)];
      // ⚠️ 挑哪一头**不能看中位数**：笔画少的块里中位数会被非笔画像素带偏，
      //    当场把深色卡片标题判成"浅字"，量出 1.03:1（真值 9 以上）。
      //    看两头哪一头离纸更远就取哪头 —— 那才是"笔画芯"的定义。
      const ink = Math.abs(lo - bg) >= Math.abs(hi - bg) ? lo : hi;
      rows.push({ ...b, ink, bg, n: glyph.length, cr: ratio(ink, bg) });
    }
    if (!rows.length) throw new Error('每一块的笔画像素都太少 —— --on= 大概没选中真正有字的元素');
    rows.sort((a, c) => a.cr - c.cr);

    for (const r of rows.slice(0, Number(opt('top', '6')))) {
      console.log(`${r.cr < floor ? '⛔' : '✅'} ${r.cr.toFixed(2)}:1  ${String(r.tag).slice(0, 20).padEnd(22)}`
        + `字 ${(r.ink * 100).toFixed(1)} / 纸 ${(r.bg * 100).toFixed(1)}  笔画 ${r.n} 像素  @${r.x},${r.y}`);
    }
    const bad = rows.filter((r) => r.cr < floor).length;
    console.log(`\n量了 ${rows.length} 块：最差 ${rows[0].cr.toFixed(2)}:1，低于 ${floor} 的有 ${bad} 块`);
    // ⚠️ 这个数只在**和白天并排**的时候有意义。单看一个夜里的数字判断不了
    // 「是压暗压过头了」还是「这块字本来就是浅色的」（元信息那行天生是铅笔灰）。
    console.log('⚠️ 判断要跟白天并排看：node web/scripts/lens.mjs contrast --at=13:00');
  } finally { await lens.close(); }
}

// ─────────────────────────────────────────────────────────────
// selftest —— 这把尺子自己准不准
// ─────────────────────────────────────────────────────────────
/**
 * ⭐⭐ 「判断一道闸在不在，要给它一个它必须拦的东西」——量具同理：
 * 要证明这把尺子看得见，就往页面上放一个**它必须量到**的东西。
 * 下面每一条都对应一次真实的踩坑。
 */
async function selftest() {
  let bad = 0;
  const ok = (pass, name, detail) => {
    console.log(`${pass ? '✅' : '⛔'} ${name}${detail ? `　${detail}` : ''}`);
    if (!pass) bad += 1;
  };

  // 1) 半透明遮罩：证明"截图 + pixelStats"这条链量得准
  {
    const lens = await open();
    try {
      await lens.goto(ROUTE, WAIT);
      const before = (await pixelStats(await lens.shot({ clip }))).mean[0];
      await lens.page.evaluate(() => {
        const d = document.createElement('div');
        d.id = '__lens_canary';
        d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.5);pointer-events:none';
        document.body.appendChild(d);
      });
      await lens.page.waitForTimeout(400);
      const after = (await pixelStats(await lens.shot({ clip }))).mean[0];
      const want = before * 0.5;
      ok(Math.abs(after - want) < 12, '亮度量得准（50% 黑遮罩）',
        `${before.toFixed(1)} → ${after.toFixed(1)}，理论 ${want.toFixed(1)}`);
    } finally { await lens.close(); }
  }

  // 2) WebGL canary：证明 LAUNCH_ARGS 没被删
  //    ⛔ 这一条查过一整天：headless 默认渲染器拍不到被 CSS 放大的 fixed 画布，
  //    页面上明明在画，截图里那层就是没有。
  {
    const lens = await open({ login: false });
    try {
      await lens.page.setContent('<style>body{margin:0;background:#F0E8D3}#c{position:fixed;inset:0;width:100%;height:100%}</style><canvas id=c></canvas>');
      const drew = await lens.page.evaluate(() => {
        const cv = document.getElementById('c'); cv.width = 200; cv.height = 120;
        const gl = cv.getContext('webgl', { alpha: true, preserveDrawingBuffer: true });
        if (!gl) return false;
        gl.clearColor(1, 0, 0, 0.5); gl.clear(gl.COLOR_BUFFER_BIT);
        return true;
      });
      await lens.page.waitForTimeout(400);
      const px = await sharp(await lens.page.screenshot({ clip: { x: 400, y: 250, width: 2, height: 2 } }))
        .raw().toBuffer({ resolveWithObject: true });
      const [r, g] = px.data;
      ok(drew && r > 200 && g < 180, 'WebGL 画布拍得到（LAUNCH_ARGS 生效）',
        `中心像素 ${[...px.data.slice(0, 3)].join(',')}${r > 200 && g < 180 ? '' : ' ← 拍不到就先查 probe-common.mjs 的启动参数'}`);
    } finally { await lens.close(); }
  }

  // 3) locale 钉住了没有
  {
    const lens = await open({ locale: 'zh-CN' });
    try {
      await lens.goto(ROUTE, WAIT);
      const v = await lens.page.evaluate(() => { try { return localStorage.getItem('nd:locale'); } catch { return null; } });
      const hasHan = await lens.page.evaluate(() => /[一-龥]/.test(document.body.innerText));
      ok(v === 'zh-CN' && hasHan, '界面语言钉在 zh-CN', `nd:locale=${v}，页面有汉字=${hasHan}`);
    } finally { await lens.close(); }
  }

  // 4) 时钟钉住了没有（钉不住的话"一天四个时刻"全是同一个时刻）
  {
    const lens = await open({ at: '03:00' });
    try {
      await lens.goto(ROUTE, WAIT);
      const h = await lens.page.evaluate(() => new Date().getHours());
      ok(h === 3, '时钟钉得住', `页面里 new Date() 报 ${h} 点`);
    } finally { await lens.close(); }
  }

  // 5) 随机数钉住了没有（钉不住的话 A/B 的差异图里全是轮播文案的鬼影）
  {
    const a = await open({ login: false });
    const b = await open({ login: false });
    try {
      // ⚠️ 必须真 goto。`setContent` 不触发 addInitScript（它不算一次导航），
      // 第一版用 setContent 验，验出来的是"没钉住" —— 而真正的页面加载是钉住的。
      // 量具的自检自己也会翻车，验法要跟真实用法一样。
      await a.page.goto('about:blank'); await b.page.goto('about:blank');
      const [x, y] = await Promise.all([
        a.page.evaluate(() => [Math.random(), Math.random()]),
        b.page.evaluate(() => [Math.random(), Math.random()]),
      ]);
      ok(x[0] === y[0] && x[1] === y[1] && x[0] !== x[1], '随机数钉得住', `两次开页拿到同一串 ${x[0].toFixed(6)}…`);
    } finally { await a.close(); await b.close(); }
  }

  // 6) 动画层定得住（不定住，"比两张的差异"这类判据全废）
  //    ⛔ 这一条是 08-30 量首页左栏字被骗出来的：光源层在两张之间飘过去，
  //    差异里全是光斑，对比度量出 1.01:1 —— 定住之后 2.07:1。**错得像真的**。
  {
    const a = await open({ login: false, freeze: true });
    const b = await open({ login: false });
    try {
      const page = '<style>body{margin:0}#m{position:fixed;left:0;top:0;width:60px;height:60px;background:#000}</style>'
        + '<div id=m></div><script>let x=0;(function f(){x=(x+7)%300;document.getElementById("m").style.transform="translateX("+x+"px)";requestAnimationFrame(f)})()<\/script>';
      const moved = async (lens) => {
        await lens.page.goto('about:blank');
        await lens.page.setContent(page);
        await lens.page.waitForTimeout(600);
        const p1 = await lens.shot({ clip: { x: 0, y: 0, width: 320, height: 60 } });
        await lens.page.waitForTimeout(600);
        const p2 = await lens.shot({ clip: { x: 0, y: 0, width: 320, height: 60 } });
        // ⚠️ 截图是 PNG，raw 出来是 4 通道 —— 按 3 步进会错位，第一版就是这么
        //    把"动了 3600 个像素"数成 60 个的。通道数要问出来，别默认。
        const raw = (z) => sharp(z).raw().toBuffer({ resolveWithObject: true });
        const [d1, d2] = await Promise.all([raw(p1), raw(p2)]);
        const ch = d1.info.channels;
        let diff = 0;
        for (let i = 0; i < d1.data.length; i += ch) if (Math.abs(d1.data[i] - d2.data[i]) > 24) diff += 1;
        return diff;
      };
      // ⚠️ freeze 走 addInitScript，setContent 不触发它 —— 所以这里先 goto about:blank
      const frozen = await moved(a);
      const live = await moved(b);
      ok(frozen === 0 && live > 100, '动画层定得住',
        `定住后动了 ${frozen} 个像素，不定住动了 ${live} 个`);
    } finally { await a.close(); await b.close(); }
  }

  console.log(bad ? `\n⛔ ${bad} 条没过 —— 在修好之前，这把尺子量出来的东西都不算数` : '\n✅ 六条全过，可以用它下结论');
  process.exit(bad ? 1 : 0);
}

const RUN = { sheet, ab, perf, contrast: contrastMode, selftest };
if (!RUN[MODE]) {
  console.log(`不认识的模式 ${MODE}。可用：${Object.keys(RUN).join(' / ')}（详见文件头）`);
  process.exit(2);
}
await RUN[MODE]();
