/**
 * server/engine/perception/session.js — 产物会话登记处（2026-08-21）
 *
 * 感知通道的**会话形态**：按 projectId 键、常驻一只 chromium、页面上的状态跨调用
 * 留着（点开的弹窗还开着、填了一半的表单还在、游戏进行到哪还在哪）。
 *
 * ## 为什么要有它
 *
 * 七个感知工具以前全是一次性的：每次调用起一只新浏览器、开页、量、关。没有会话，
 * 于是"点开菜单 → 填表 → 提交 → 看校验"这种检查只能靠 beforeShot 塞 JS 假装，
 * 而 hover 态 / 焦点顺序 / 方向键连按 / 拖拽 / pointer lock 这些只认真实手势。
 * 同一套 launch→open→goto→close 生命周期还抄了七份（"没走成 http 要把 note 写进
 * 返回"那条契约靠 lint 钉着，就是抄多了的症状）。
 *
 * 这里成为"打开产物页"的**唯一一份**实现的一半：会话态归这里；一次性那半在
 * helpers/acquire-page.js 里跟它合成同一个出口（`acquireArtifactPage`），老工具
 * 加 `live:true` 就走会话页，不传就照旧新开一只可复现的。
 *
 * ## 跟浏览通道（engine/browse/registry.js）刻意分开
 *
 * 那边：URL agent 定、loopback 一律禁、持久 profile、出网闸。这边：URL 我们按
 * 工作区路径构造、loopback 必须通（产物就在 127.0.0.1:4001 上）、铸 cookie、
 * 没有出网闸（产物本来就会拉 CDN 字体和库）。安全前提相反，不能拿 flag 切。
 * 共享的只有 FIDELITY_LAUNCH_ARGS 那份常量。
 *
 * ## 坐标比例
 *
 * 产物视口按形态定（站 1440×900 / 设备宽、deck 1920×1080…），不是为了坐标 1:1 挑的。
 * 所以每个会话记一个 frame = 截图空间 {w,h,scale}：模型从图上读的坐标 ÷ scale =
 * 页面像素（文档推荐做法）。browse 那边 scale 恒 1，两边走同一条 runAction。
 *
 * ## 1 vCPU
 *
 * 默认常驻上限 1（ND_ARTIFACT_SESSION_MAX），空闲 3 分钟回收；浏览通道另有它的 2。
 * 同项目调用走 mutex 串行。页面上的文件改了**不自动刷**（刷掉状态比提醒坏），
 * 每次动作前对账 mtime，变了就在返回里提醒 artifact_open 重载。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { mutex } from 'async-mutex-lite';
import { resolveCanvasTarget, KIND_SITE, requireBrowsable } from '../../lib/artifact-target.js';
import { resolveDeckSize, extractDeckAspect } from '../../shared/deck.js';
import { openArtifactPage, launchPerceptionBrowser, SITE_DEVICE_W, previewPathProblem } from '../mcp/tools/helpers/perception-page.js';
import { attachPageDiagnostics, API_IMAGE_LIMITS } from '../mcp/tools/helpers/shot-pipeline.js';

const MAX_RESIDENT = Number(process.env.ND_ARTIFACT_SESSION_MAX) > 0
  ? Math.floor(Number(process.env.ND_ARTIFACT_SESSION_MAX)) : 1;
const IDLE_MS = Number(process.env.ND_ARTIFACT_SESSION_IDLE_MS || 0) || 3 * 60 * 1000;
const GOTO_TIMEOUT_MS = 15000;

/**
 * 没有会话时的报错（09-17）：agent 隔几分钟回来用 live:true，会话已被空闲回收，只看到「没开」会以为
 * 自己没开过或开失败了。回收时长按 IDLE_MS 的实际值说（环境变量可改），别写死。
 */
export function noSessionText(idleMs = IDLE_MS) {
  const idle = idleMs >= 60_000 ? `${Math.round(idleMs / 60_000)} minutes` : `${Math.round(idleMs / 1000)} seconds`;
  return 'No artifact session is open for this project — call artifact_open first (or drop live:true to take a fresh one-shot look). '
    + `An open session is closed automatically after about ${idle} idle; just artifact_open again (the page state starts over).`;
}

/** projectId → entry */
const live = new Map();

/** 视口 → 截图空间。跟 shot-pipeline 的归一化同一套算法，所以截图实际尺寸 = 这里算的 */
export function frameFor(viewport) {
  const { width: w, height: h } = viewport;
  const scale = Math.min(1, API_IMAGE_LIMITS.longEdge / Math.max(w, h), Math.sqrt(API_IMAGE_LIMITS.maxPixels / (w * h)));
  return { w: Math.round(w * scale), h: Math.round(h * scale), scale };
}

/** 产物默认视口：站点按设备宽（版面是宽度算出来的），deck 按画幅 */
export async function defaultViewportFor(target, device) {
  if (target.kind === KIND_SITE) return { width: SITE_DEVICE_W[device || 'desktop'] || SITE_DEVICE_W.desktop, height: 900 };
  const html = await fs.readFile(target.absPath, 'utf8').catch(() => '');
  const d = resolveDeckSize(extractDeckAspect(html));
  return { width: d.width, height: d.height };
}

/** 产物文件签名：主文件 + 同目录一层的文件 mtime（≤60 个）。够发现"改了没重载" */
async function fileSig(absPath) {
  const sig = new Map();
  const dir = path.dirname(absPath);
  try {
    const st = await fs.stat(absPath);
    sig.set(absPath, st.mtimeMs);
  } catch { /* 主文件没了也记不到 */ }
  try {
    const names = (await fs.readdir(dir)).filter(n => !n.startsWith('.') && n !== 'node_modules').slice(0, 60);
    for (const n of names) {
      const p = path.join(dir, n);
      try { const st = await fs.stat(p); if (st.isFile()) sig.set(p, st.mtimeMs); } catch { /* */ }
    }
  } catch { /* */ }
  return sig;
}

function touch(entry) {
  entry.lastUsed = Date.now();
  clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => { closeSession(entry.projectId, 'idle').catch(() => {}); }, IDLE_MS);
  entry.idleTimer.unref?.();
}

export async function closeSession(projectId, why = 'explicit') {
  const e = live.get(projectId);
  if (!e) return false;
  live.delete(projectId);
  clearTimeout(e.idleTimer);
  try { await e.browser.close(); } catch { /* */ }
  console.log(`[artifact-session] closed ${projectId} (${why})`);
  return true;
}

async function evictOne() {
  const idle = [...live.values()].filter(e => !e.busy).sort((a, b) => a.lastUsed - b.lastUsed);
  if (!idle.length) return false;
  await closeSession(idle[0].projectId, 'evicted (LRU)');
  return true;
}

/**
 * 打开（或重载）一个产物会话。同一路径同一视口再 open = 重载（状态清零，文件签名刷新）。
 * @returns {Promise<{entry: object, reloaded: boolean, gotoNote: string|null}>}
 */
export async function openSession({ projectId, workspaceRoot, sessionId, relPath, device, viewport }) {
  return mutex(`artifact-session:${projectId}`, async () => {
    const target = await resolveCanvasTarget(workspaceRoot, relPath, sessionId);
    if (!target || !target.ok) throw new Error(target?.message || 'No artifact found to open — pass path (a site folder\'s index.html, a page file, or a deck .html).');
    const guard = requireBrowsable(target);
    if (guard) throw new Error(guard);
    const vp = viewport || await defaultViewportFor(target, device);

    let entry = live.get(projectId);
    const same = entry && !entry.page.isClosed() && entry.target.absPath === target.absPath
      && entry.viewport.width === vp.width && entry.viewport.height === vp.height;
    if (entry && !same) { await closeSession(projectId, 'reopen with different target/viewport'); entry = null; }

    let gotoNote = null;
    if (entry) {
      try { await entry.page.reload({ waitUntil: 'load', timeout: GOTO_TIMEOUT_MS }); } catch (err) {
        if (!/Timeout/i.test(String(err?.message))) throw err;
        gotoNote = `load not reached in ${GOTO_TIMEOUT_MS / 1000}s — continuing anyway`;
      }
      entry.sig = await fileSig(target.absPath);
      entry.openedAt = Date.now();
      touch(entry);
      return { entry, reloaded: true, gotoNote };
    }

    if (live.size >= MAX_RESIDENT && !(await evictOne())) {
      throw Object.assign(new Error(`产物会话已满（${live.size}/${MAX_RESIDENT} 都在用）—— 这台机器 1 个 CPU 核，常驻上限是硬的；等一会儿再试。`), { status: 503 });
    }
    // 预览通道服不出的路径（点开头的目录）不起浏览器（09-17，iss_mtdfvijv_pn5h）
    const unservable = previewPathProblem(workspaceRoot, target.absPath);
    if (unservable) throw new Error(unservable);
    const t0 = Date.now();
    const browser = await launchPerceptionBrowser();
    let opened;
    try {
      opened = await openArtifactPage(browser, {
        projectId, workspaceRoot, absPath: target.absPath, viewport: vp, deviceScaleFactor: 1,
        waitUntil: 'load', timeout: GOTO_TIMEOUT_MS,
      });
      const diag = attachPageDiagnostics(opened.page, { console: 'all' });
      try { await opened.goto(); } catch (err) {
        if (!/Timeout/i.test(String(err?.message))) throw err;
        gotoNote = `load not reached in ${GOTO_TIMEOUT_MS / 1000}s — continuing anyway`;
      }
      entry = {
        projectId, browser, context: opened.context, page: opened.page, diag,
        target, viewport: vp, frame: frameFor(vp),
        note: opened.note, viaHttp: opened.viaHttp, url: opened.url,
        sig: await fileSig(target.absPath), openedAt: Date.now(),
        lastUsed: Date.now(), busy: false, idleTimer: null,
      };
      live.set(projectId, entry);
      touch(entry);
      console.log(`[artifact-session] opened ${projectId} ${target.relPath} ${vp.width}x${vp.height} in ${Date.now() - t0}ms`);
      return { entry, reloaded: false, gotoNote };
    } catch (err) {
      try { await browser.close(); } catch { /* */ }
      throw err;
    }
  });
}

/** 文件改没改：返回改过的相对路径列表（空 = 没变） */
export async function changedSinceOpen(entry) {
  const now = await fileSig(entry.target.absPath);
  const changed = [];
  for (const [p, m] of now) {
    const prev = entry.sig.get(p);
    if (prev == null || m > prev) changed.push(path.relative(path.dirname(entry.target.absPath), p));
  }
  return changed;
}

export function peekSession(projectId) {
  const e = live.get(projectId);
  return e && !e.page.isClosed() ? e : null;
}

/**
 * 拿着会话页干活（同项目串行）。没开会话就抛，让调用方回一句可执行的错误。
 * @param {(entry: object) => Promise<any>} fn
 */
export async function withSession(projectId, fn) {
  return mutex(`artifact-session:${projectId}`, async () => {
    const entry = peekSession(projectId);
    if (!entry) {
      if (live.has(projectId)) await closeSession(projectId, 'page was closed underneath us');
      throw new Error(noSessionText());
    }
    entry.busy = true;
    try { touch(entry); return await fn(entry); } finally { entry.busy = false; touch(entry); }
  });
}

/** 手动锁：给要跨 try/finally 的调用方（老工具 live 模式）用。返回 release。 */
export function lockSession(projectId) {
  let release;
  const gate = new Promise((res) => { release = res; });
  const held = new Promise((resolve, reject) => {
    mutex(`artifact-session:${projectId}`, async () => {
      const entry = peekSession(projectId);
      if (!entry) {
        reject(new Error(noSessionText()));
        return;
      }
      entry.busy = true;
      touch(entry);
      resolve({ entry, release: () => { entry.busy = false; touch(entry); release(); } });
      await gate;
    }).catch(reject);
  });
  return held;
}

/** 给体检/日志用 */
export function status() {
  return [...live.values()].map(e => ({
    projectId: e.projectId, target: e.target.relPath, viewport: e.viewport, frame: e.frame,
    idleMs: Date.now() - e.lastUsed, busy: e.busy,
  }));
}

export const _limits = { MAX_RESIDENT, IDLE_MS };
