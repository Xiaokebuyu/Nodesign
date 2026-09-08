/**
 * lib/cover.js — 项目封面（首页卡片缩略图）
 *
 * 为什么是截图而不是 iframe：
 *   首页早期版本用 iframe 直接挂 canvas.html 当封面，且 sandbox 不给 allow-scripts
 *   （一屏十几张卡，放开脚本等于每张卡都跑一遍生成页的动画 / 3D）。代价是**凡是靠
 *   JS 出画面的产物封面全是空白**——站点的滚动揭示、three.js 场景、图表库全中招。
 *   服务端截一次图就没这个矛盾：脚本在 chromium 里真跑，浏览器只收一张 webp。
 *
 * 选谁当封面：/artifacts 的口径——任务目录 mtime 新→旧，第一个真有产物的任务的
 * artifacts[0]（形态注册表已经把 canvas.html / 根 index.html 排在别的稿前面）。
 *
 * 取景按形态：
 *   deck — viewport = 真实画幅（16:9 / 16:10 / 9:16 / 4:3），整页入镜
 *   site — 页面高度无上界，按桌面宽 1440 渲染取顶部一屏（首屏即封面）
 *
 * 缓存：<cacheDir>/<pid>/<sha1(任务|入口|mtime|宽)>.webp。key 带源 mtime，
 * agent 改完产物下次请求自然重截；旧文件留着不清（一个项目也就攒几张几十 KB）。
 * 并发：截图串行（chromium 一次一个），十张卡同时冷启也只排队不炸内存。
 */

import path from 'node:path';
import { platform } from '../runtime/platform.js';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { taskManifest, can } from './kinds/index.js';
import { resolveArtifactFile } from './artifact-file-path.js';
import { fileUrl } from './file-url.js';
import { resolveDeckSize, extractDeckAspect } from '../shared/deck.js';
import { openArtifactPage, launchPerceptionBrowser } from '../engine/mcp/tools/helpers/perception-page.js';

const SITE_VIEWPORT = { width: 1440, height: 900 };
const OUT_WIDTH = 800;          // 出图宽度（卡片最宽也就 ~400 CSS px，2x 足够）
const CACHE_DIR = path.join(platform.cacheRoot, 'covers');

/** 截图串行闸门 —— 冷启动时十张卡同时请求也只有一个 chromium 在跑 */
let renderChain = Promise.resolve();
function serialize(fn) {
  const next = renderChain.then(fn, fn);
  renderChain = next.catch(() => {});
  return next;
}

/**
 * 选出项目封面产物。
 * @returns {Promise<null | { taskId, kind, view, absPath, relPath, mtimeMs }>}
 */
export async function pickCoverArtifact(sharedDir) {
  // 扁平化之前这里先按 mtime 把任务目录排个序，再从最新那个任务里取头一份产物。
  // 现在产物都在工作区根上并排放着，直接按**产物**的 mtime 挑最新的那份。
  const manifest = await taskManifest(sharedDir).catch(() => null);
  const list = manifest?.artifacts || [];
  const dated = [];
  for (const art of list) {
    try {
      dated.push({ art, mtimeMs: (await fs.stat(path.join(sharedDir, art.entryRel))).mtimeMs });
    } catch { /* 入口是声明出来的但还没写盘 → 换下一份 */ }
  }
  dated.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const { art } of dated) {
    // ⚠️ 2026-08-18：docx 进来之后这里会挑到一个 .docx 当封面，chromium 打开它
    // 只会触发 "Download is starting"，封面整个渲不出来（生产日志实锤）。
    // 加形态时最容易漏的就是这种「默认所有产物都能用浏览器打开」的假设 ——
    // 按能力位问，别按形态名问。renderable（docx）也能当封面：renderCoverShot
    // 里按能力分流走 LO 页图，不进 chromium —— 纯 word 项目的首页卡不再开天窗。
    if (!can(art.kind, 'browsable') && !can(art.kind, 'renderable')) continue;
    const taskDir = sharedDir;
    const absPath = path.join(taskDir, art.entryRel);
    let fileMtime = 0;
    try {
      fileMtime = (await fs.stat(absPath)).mtimeMs;
    } catch { continue; }   // 入口是声明出来的但还没写盘 → 换下一个任务
    return {
      taskId: null,
      kind: art.kind,
      view: art.view,
      absPath,
      relPath: art.entryRel,
      mtimeMs: fileMtime,
    };
  }
  return null;
}

/**
 * 真正跑一次 chromium，返回 JPEG buffer。
 * 导出是为了能单独对某个产物验证取景（缓存/选片逻辑之外的那一半）。
 * @param {{ absPath: string, kind: 'deck'|'site' }} cover
 * @param {{ projectId?: string, workspaceRoot?: string }} [pctx]
 *   给了就走 http（与用户预览同源）—— 用 fetch 装内容的站点在 file:// 下
 *   封面会是一张空白页。⚠️ 这里**允许静默退回 file://**：封面是给用户看的
 *   缩略图，没有 agent 会被误导，宁可退化也别让首页卡片开天窗。
 */
export async function renderCoverShot(cover, pctx = {}) {
  // renderable 产物（docx）没有 DOM：封面 = 第一页页图，跟画布缩略图同一份
  // LibreOffice 缓存，别把二进制包喂给 chromium（那只会触发下载弹窗）
  if (!can(cover.kind, 'browsable')) {
    const { pageImage } = await import('./docx-pages.js');
    return (await pageImage(cover.absPath, 1, { width: OUT_WIDTH })).buf;
  }
  const html = await fs.readFile(cover.absPath, 'utf8').catch(() => '');
  const viewport = cover.kind === 'deck'
    ? (() => { const d = resolveDeckSize(extractDeckAspect(html)); return { width: d.width, height: d.height }; })()
    : SITE_VIEWPORT;

  let browser;
  try {
    browser = await launchPerceptionBrowser();
    const opened = await openArtifactPage(browser, {
      projectId: pctx.projectId, workspaceRoot: pctx.workspaceRoot,
      absPath: cover.absPath, viewport, deviceScaleFactor: 1, timeout: 20_000,
    });
    const ctx = opened.context;
    const page = opened.page;
    try {
      await opened.goto();
    } catch (err) {
      if (!opened.viaHttp) throw err;
      console.warn('[cover] http 加载失败，退回 file://:', err.message);
      await page.goto(fileUrl(cover.absPath), { waitUntil: 'networkidle', timeout: 20_000 });
    }
    // 字体加载完再截（同导出管线的口径：CJK 子集是 lazy 的，不显式 load 会截到 fallback）
    await page.evaluate(async () => {
      document.body.offsetHeight;
      await Promise.all(Array.from(document.fonts).map(f => f.load().catch(() => {})));
      await document.fonts.ready;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    }).catch(() => { /* 页面自己抛错也照样截，截到什么算什么 */ });
    // deck 的 standalone-fit 脚本在真实 viewport 下会再缩一次，抹掉它
    await page.addStyleTag({ content: `
      body { margin: 0 !important; padding: 0 !important; }
      body.__nd-fit-active > .__nd-deck-wrap > .__nd-page-frame {
        width: ${viewport.width}px !important; height: ${viewport.height}px !important;
        display: block !important; overflow: visible !important;
      }
      body.__nd-fit-active section[data-page] { transform: none !important; }
    ` }).catch(() => {});
    await page.waitForTimeout(600);   // 给入场动画 / 首帧渲染一点时间
    const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, ...viewport } });
    await ctx.close();

    const { default: sharp } = await import('sharp');
    return await sharp(png)
      .resize({ width: OUT_WIDTH, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } finally {
    await browser?.close().catch(() => {});
  }
}

/**
 * 指定产物的封面目标（橱窗用：某件具体作品，不是"项目最新那件"）。
 *
 * @param {string} relPath  产物入口，相对工作区根。橱窗表里的存量数据是
 *   扁平化之前的 `tasks/<任务>/<入口>`，前两段剥掉就是现在的位置。
 */
export async function resolveCoverTarget(sharedDir, relPath) {
  // ⛔ 这里原来无条件剥掉 `tasks/<名>/` 前缀（跟 artifact-file 路由犯过同一个错，
  // 那是**第三份**同样的判据）。而橱窗存的 artifact_rel 恰恰就是那个形状 ——
  // 线上两条橱窗条目实测：文件真的在 `shared/tasks/伊蕾娜手账研究站/index.html`，
  // 剥完变成 `shared/index.html`（不存在）→ 返 null → 封面接口 204 → **橱窗无图**。
  // 收敛到 lib/artifact-file-path.js 那一份：先看原路径在不在，在就别动它。
  const resolved = await resolveArtifactFile(sharedDir, String(relPath || '').replace(/\\/g, '/'));
  if (!resolved.ok) return null;
  const { absPath, subPath: rel } = resolved;
  const taskDir = sharedDir;
  let fileMtime = 0;
  try {
    fileMtime = (await fs.stat(absPath)).mtimeMs;
  } catch { return null; }
  const manifest = await taskManifest(taskDir).catch(() => null);
  const art = manifest?.artifacts?.find(a => a.entryRel === rel) || manifest?.artifacts?.[0];
  return {
    taskId: null,
    kind: art?.kind || 'site',   // 认不出来按 site 取景（首屏一屏，比硬套 16:9 安全）
    view: art?.view || 'site',
    absPath,
    relPath: rel,
    mtimeMs: fileMtime,
  };
}

/**
 * 拿项目封面 JPEG（命中缓存直接读盘，否则截一张）。
 * @returns {Promise<null | { buffer, etag, cover }>}  没有任何产物时返回 null
 */
export async function getProjectCover(pid, sharedDir) {
  const cover = await pickCoverArtifact(sharedDir);
  if (!cover) return null;
  return renderOrRead(pid, cover, sharedDir);
}

/** 指定产物的封面（橱窗卡片） */
export async function getArtifactCover(pid, sharedDir, relPath) {
  const cover = await resolveCoverTarget(sharedDir, relPath);
  if (!cover) return null;
  return renderOrRead(pid, cover, sharedDir);
}

async function renderOrRead(pid, cover, sharedDir) {
  // ⚠️ key 里要带**渲染方式的版本**。08-18 感知层从 file:// 改走 http（同源，
  // fetch/localStorage 才活），但缓存 key 只认 relPath|mtime|宽度 —— 于是改动
  // 之前渲的封面（file:// 版，页面里 fetch 回来的内容一片空白）会一直供着，
  // 直到 HTML 自己被改动。渲染管线换了就该换一代 key。
  // v2（2026-08-19）：docx 字体替身换代（雅黑→MiSans、仿宋→朱雀仿宋），
  // 封面里渲着 docx 页图的那批要跟着重截
  const RENDER_GEN = 'http-v2';
  const etag = crypto.createHash('sha1')
    .update(`${cover.relPath}|${cover.mtimeMs}|${OUT_WIDTH}|${RENDER_GEN}`)
    .digest('hex');
  const file = path.join(CACHE_DIR, pid, `${etag}.webp`);

  try {
    return { buffer: await fs.readFile(file), etag, cover };
  } catch { /* 未命中 → 截 */ }

  const buffer = await serialize(async () => {
    // 排队期间可能已经被前一个同 key 的请求截好了，再看一眼再动手
    try { return await fs.readFile(file); } catch { /* */ }
    const buf = await renderCoverShot(cover, { projectId: pid, workspaceRoot: sharedDir });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, buf);
    return buf;
  });
  return { buffer, etag, cover };
}
