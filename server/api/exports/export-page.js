/**
 * exports/export-page.js — deck 导出（PDF / PPTX / 单页 HTML）的共用底座。
 *
 * 2026-08-17 从 exports.js 搬出来。这两个函数是**纯辅助**，被 pdf / pptx /
 * html 三条路由共用，本来就不该住在路由文件里。
 *
 * ⚠️ 上一次拆 exports.js（拆 handoff）时，它俩是被**误伤**带走的，`node --check`
 * 和 vite build 都不报，只有 no-undef.lint 抓到了。这次是**故意**给它们安家，
 * 顺带把那次事故的教训坐实成目录结构。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileUrl } from '../../lib/file-url.js';
import { resolveDeckSize, extractDeckAspect } from '../../shared/deck.js';
import { fitInjectionBlock } from '../standalone-fit.js';
import { buildStandaloneHtml, isHybridHtml } from './build-standalone.js';

/**
 * 共用导出准备：启 Playwright page、等字体/图片就绪、注入基线 reset、探测实际 section 尺寸。
 * 返回 { page, ctx, pageSize: { w, h } }。
 *
 * 多比例支持：先读 canvas.html 抽 wrap data-deck-aspect → 设对应 viewport
 * （16:9=1920×1080 / 9:16=1080×1920 / 4:3=1440×1080）。
 */
export async function prepareExportPage(browser, filePath, opts = {}) {
  const dpr = opts.dpr ?? 2;

  // 读文件抽 deck 比例 → 决定 viewport
  const html = await fs.readFile(filePath, 'utf8').catch(() => '');
  const aspect = extractDeckAspect(html);
  const dims = resolveDeckSize(aspect);

  // 跑跟 /exports/html 同款 standalone 管道——把 Google Fonts / 本地图片 / CDN
  // 全 inline，写到 tmp 文件让 Playwright 从那加载。这样 PDF/PPT 用的字体跟
  // HTML 下载产物 1:1，不再依赖 server 能否 reach fonts.googleapis.com（国内
  // 网络 / firewall 直接封死的话原方案 PDF 字体会无声 fallback 到系统字体）。
  // hybrid 检测失败或 build 失败 → fallback 到原 file://，至少导出能跑通。
  let loadPath = filePath;
  let cleanup = async () => {};
  if (isHybridHtml(html)) {
    try {
      const baked = await buildStandaloneHtml(html, { sessionRoot: opts.sessionRoot, baseDir: path.dirname(filePath) });
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-export-'));
      const tmpFile = path.join(tmpDir, 'baked.html');
      await fs.writeFile(tmpFile, baked, 'utf8');
      loadPath = tmpFile;
      cleanup = async () => { await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); };
    } catch (err) {
      console.warn('[prepareExportPage] standalone bake failed, loading raw canvas.html:', err.message);
    }
  }

  const ctx = await browser.newContext({
    viewport: { width: dims.width, height: dims.height },
    deviceScaleFactor: dpr,
  });
  const page = await ctx.newPage();
  await page.goto(fileUrl(loadPath), { waitUntil: 'networkidle', timeout: 30_000 });

  // 字体强等待——比 await document.fonts.ready 严格得多。
  //
  // 背景：Google Fonts 把 CJK 字体（Noto Sans SC）拆成 80+ 个 unicode-range
  // 子集，每个子集 + 每个 weight 是独立 @font-face。HTML 用 font-display: swap
  // 的话浏览器先用 fallback 字体绘制，字体异步加载完后 swap。
  //
  // document.fonts.ready 只等"已经 pending 的"face——CSS 引用了但还没被使用
  // 过的 face 不算 pending（lazy load 机制）。截图时若某个 weight × range
  // 子集还没被触发，PDF/PPT 就截到 swap 前的 fallback 字体（preview 走 macOS
  // 系统字体看着对，PPT/PDF 走 Linux Chromium 默认字体看着错）。
  //
  // 4 步保 ready：
  //   1. 强制 layout（让所有字体使用注册到 FontFaceSet）
  //   2. 显式 .load() 所有声明的 face（含未被使用的 weight × range 子集）
  //   3. await document.fonts.ready（兜底等剩余 pending）
  //   4. 双 rAF 等 paint 真正应用 swap
  await page.evaluate(async () => {
    document.body.offsetHeight;  // force layout
    const faces = Array.from(document.fonts);
    await Promise.all(faces.map((f) => f.load().catch(() => {})));
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await page.waitForTimeout(200);  // 短兜底（rAF 后再给 paint 一帧时间）

  // 抹掉 body margin + 砍掉 fit-active 视觉缩放（如果 file:// 加载的 canvas.html
  // 有 standalone-fit script，frame 包装 + section transform: scale 会让 boundingBox
  // 拿到的不是设计稿原坐标）。Playwright viewport 已经 = deck 比例，原生渲染。
  await page.addStyleTag({ content: `
    body { margin: 0 !important; padding: 0 !important; }
    body.__nd-fit-active > .__nd-deck-wrap > .__nd-page-frame {
      width: ${dims.width}px !important; height: ${dims.height}px !important;
      display: block !important; overflow: visible !important;
    }
    body.__nd-fit-active section[data-page] { transform: none !important; }
  ` });

  const fallback = { w: dims.width, h: dims.height };
  const pageSize = await page.evaluate((fb) => {
    const first = document.querySelector('section[data-page]');
    if (!first) return fb;
    const rect = first.getBoundingClientRect();
    return { w: Math.round(rect.width), h: Math.round(rect.height) };
  }, fallback);

  return { page, ctx, pageSize, cleanup };
}

/**
 * 导出 HTML 时注入 viewport 自适应脚本（服务端兜底）。
 *
 * 逻辑：scale(viewportWidth / DECK.width) 让任意视口宽都满铺 + 完整。
 * 仅在独立打开时生效（iframe 内 window!==top 早退，前端 CanvasFrame 自算 scale）。
 *
 * 行为升级（2026-05-08）：内部改调 server/api/standalone-fit.js 的 fitInjectionBlock()，
 * 升级到 4 mode 感知（stack/ppt/carousel/custom）+ transform-origin: top left。
 * 调用方零改动，老 deck（无 data-deck-mode attr）自动按 stack 兜底。
 */
export function injectViewportFit(html) {
  // 1. 替换 agent 写的固定 viewport meta → 响应式 viewport（让 fit script 控）
  if (/<meta\s+name=["']viewport["'][^>]*>/i.test(html)) {
    html = html.replace(
      /<meta\s+name=["']viewport["'][^>]*>/i,
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
    );
  } else if (html.includes('</head>')) {
    html = html.replace(
      '</head>',
      '<meta name="viewport" content="width=device-width,initial-scale=1">\n</head>',
    );
  }

  // 2. 调 standalone-fit 拼完整 fit injection block 注入
  const block = fitInjectionBlock();
  if (html.includes('</body>')) {
    return html.replace('</body>', block + '\n</body>');
  }
  if (html.includes('</html>')) {
    return html.replace('</html>', block + '\n</html>');
  }
  return html + block;
}
