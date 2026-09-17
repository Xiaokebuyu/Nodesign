/**
 * helpers/acquire-page.js — 感知工具拿到"那一页"的唯一出口（2026-08-21）
 *
 * 两条路一个形状：
 *   - `live: true`  → 产物会话里**现在这一页**（engine/perception/session.js），
 *                      状态保留，用完不关，只松锁
 *   - 否则          → 新开一只保真 chromium，openArtifactPage，goto，用完关 —— 可复现
 *
 * 老工具以前各自抄 launch→open→goto→close（七份），"没走成 http 要把 note 写进返回"
 * 那条契约也是各自记各自漏。现在 goto 的超时容忍、退化 note、viaHttp 都在这一处出。
 *
 * 返回：{ page, live, viewport, note, viaHttp, gotoNote, liveNote, diag, release() }
 *   - note      非空 = 没走成 http（退回 file://），调用方照旧用 degradedNote(acq) 拼进返回文本
 *   - gotoNote  非空 = load/networkidle 没等到（照样继续，caption 要说）
 *   - liveNote  live 模式下告诉 agent：视口/设备参数被忽略、会话视口是多少
 *   - diag      传了 diagnostics 才有（attachPageDiagnostics 的返回）
 *   - release   **必须在 finally 里调**：一次性模式关浏览器，live 模式松会话锁
 *
 * ⛔ 诊断监听必须挂在 goto **之前**（09-17，问题库 iss_mt886uc1_7rne）。08-21 把取页收进这里之后，
 * 返回前已经 goto 完（networkidle），screenshot / trace_motion 拿到页面再挂监听，加载期的
 * requestfailed、≥400 响应、MIME 拒绝执行这类控制台错误全部错过，白屏站的 caption 仍是
 * 「console clean, all requests OK」。重构前是先挂再 goto；所以挂监听这一步归这个出口，
 * 调用方传 diagnostics，别自己在拿到页面之后再挂。
 */
import { openArtifactPage, launchPerceptionBrowser, previewPathProblem } from './perception-page.js';
import { attachPageDiagnostics } from './shot-pipeline.js';
import { lockSession } from '../../../perception/session.js';
import { gatedBrowser, browserSlots } from './browser-slots.js';

/**
 * @param {object} o
 * @param {string} o.projectId
 * @param {string} o.workspaceRoot
 * @param {{absPath:string, relPath:string}} o.target   resolveCanvasTarget 的结果
 * @param {{width:number,height:number}} [o.viewport]   一次性模式用；live 模式忽略
 * @param {number} [o.deviceScaleFactor]                一次性模式用
 * @param {boolean} [o.live]
 * @param {string} [o.waitUntil]                        默认 networkidle（老工具的口径）
 * @param {number} [o.timeout]
 * @param {boolean} [o.exclusive]                     一次性模式用：要量帧时间的拿全部浏览器槽位（browser-slots.js）
 * @param {object} [o.diagnostics]                    给了就挂页面诊断（attachPageDiagnostics 的 opts），结果在 acq.diag。
 *                                                    一次性模式在 goto 之前挂；live 模式页面早已加载，只收本次调用期间的事件
 */
export async function acquireArtifactPage({
  projectId, workspaceRoot, target, viewport, deviceScaleFactor = 1, live = false,
  waitUntil = 'networkidle', timeout = 15000, exclusive = false, diagnostics = null,
}) {
  if (live) {
    const { entry, release: unlock } = await lockSession(projectId);
    // 量帧时间的在会话页上测也要独占浏览器槽位：会话浏览器不占槽，但同时开着的一次性浏览器照样抢 CPU。
    // 顺序固定（先会话锁、后槽位），一次性工具只拿槽位不拿会话锁，不会互等
    const unslot = exclusive ? await browserSlots.acquire(Infinity, projectId) : () => {};
    const diag = diagnostics ? attachPageDiagnostics(entry.page, diagnostics) : null;
    // 会话页常驻，监听不摘就在同一页上越积越多
    const release = () => { diag?.detach(); unslot(); unlock(); };
    if (target?.absPath && entry.target.absPath !== target.absPath) {
      release();
      throw new Error(`The live session is on ${entry.target.relPath}, not ${target.relPath}. `
        + 'Either omit path (to inspect the live page), artifact_open that file first, or drop live:true.');
    }
    const vp = entry.viewport;
    // 会话里可能已经站内导航过（index → about），报现在的页，不报当初开的那个
    let now = entry.target.relPath;
    try {
      const u = new URL(entry.page.url());
      if (/\/artifact-file\//.test(u.pathname)) now = decodeURIComponent(u.pathname.replace(/^.*\/artifact-file\//, ''));
    } catch { /* */ }
    const liveNote = `live session page (now at ${now}, viewport ${vp.width}x${vp.height} — current interaction state, `
      + 'not a fresh load; viewport/device params are ignored here)';
    return {
      page: entry.page, live: true, viewport: vp, note: entry.note, viaHttp: entry.viaHttp,
      gotoNote: null, liveNote, diag, release: async () => release(),
    };
  }

  // 预览通道服不出的路径（点开头的目录）不起浏览器，直接说原因（09-17，iss_mtdfvijv_pn5h）
  const unservable = previewPathProblem(workspaceRoot, target?.absPath);
  if (unservable) throw new Error(unservable);
  const browser = await gatedBrowser(() => launchPerceptionBrowser(), { exclusive, key: projectId });
  try {
    const opened = await openArtifactPage(browser, {
      projectId, workspaceRoot, absPath: target.absPath, viewport, deviceScaleFactor, waitUntil, timeout,
    });
    const diag = diagnostics ? attachPageDiagnostics(opened.page, diagnostics) : null;   // 先挂监听，再导航
    let gotoNote = null;
    try { await opened.goto(); } catch (err) {
      if (!/Timeout/i.test(String(err?.message))) throw err;
      gotoNote = `${waitUntil} not reached in ${Math.round(timeout / 1000)}s (slow/looping network activity) — captured anyway`;
    }
    return {
      page: opened.page, live: false, viewport, note: opened.note, viaHttp: opened.viaHttp,
      gotoNote, liveNote: null, diag,
      release: async () => { try { await browser.close(); } catch { /* */ } },
    };
  } catch (err) {
    try { await browser.close(); } catch { /* */ }
    throw err;
  }
}

/** live 参数的统一说明文字（五个工具共用一句，别各说各的） */
export const LIVE_PARAM_DESC = 'Inspect the page currently open in the artifact session (artifact_open) — its present '
  + 'interaction state (opened menus, typed input, game state) instead of a fresh load. Viewport/device params '
  + 'are ignored in live mode (the session has its own). Default false = fresh reproducible load.';
