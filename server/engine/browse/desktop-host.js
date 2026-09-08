/**
 * server/engine/browse/desktop-host.js — 桌面版共视：agent 的浏览器住在 Electron 里（2026-09-08 缝二）
 *
 * ## 是什么
 *
 * 托管版 / npx 版里 agent 的浏览器是服务端起的 headless chromium，画面截帧推到画布那扇窗里。桌面版换底：
 * 页面由 **Electron 的 WebContentsView** 原生显示在画布那扇窗的位置上（真画面、原生滚动 / 输入 / 视频），
 * agent 那边 **playwright 走 CDP 连进 Electron 自己的 chromium**（`chromium.connectOverCDP`），拿到的是同一页的
 * playwright Page —— 工具层（browser_computer / navigate / capture …）一行不改。
 *
 * ## 三个坐标系怎么对齐（09-08 spike 实测，别再猜）
 *
 * 工具层写死 1366×768、坐标 1:1。视图在窗里的矩形是变的，所以：Electron 给视图设 **zoomFactor = 矩形宽 / 1366**
 * （16:9 的矩形），页面 innerWidth 恒 1366、CSS 坐标 1:1、playwright 截图 1366×768；再用 CDP 把
 * deviceScaleFactor 钉 1，HiDPI 屏上截图也不放大。⛔ `Emulation.setDeviceMetricsOverride` 的 `scale`
 * 那条路**不行**：输入坐标会被除以 scale（spike 里 (600,300) 落到 (1200,600)）。
 * ⚠️ Chromium 的 zoom 按 origin 记，换站会归 1 —— Electron 侧 did-navigate 时重设（desktop/browser-host.cjs）。
 *
 * ## 谁跟谁说话
 *
 *   服务端 ──HTTP(bridge, Bearer)──▶ Electron 主进程：建 / 销 / 遮罩视图
 *   服务端 ──CDP(playwright)────▶ Electron 的 chromium：操作页面
 *   渲染层 ──IPC(preload)──────▶ Electron 主进程：视图该摆在哪个矩形、agent 在不在操作（遮罩）
 * 三样地址由 Electron 起服务端时塞进 env：NODESIGN_DESKTOP_BRIDGE / _BRIDGE_TOKEN / _CDP。
 *
 * ## 边界
 *
 * - 登录态：所有项目共用一个 partition（`persist:nd-browser`），站主 09-07 定的「同用户全项目共登录态」。
 * - 出网闸照旧两道：Electron 那个 partition 的 session 走服务端的 browse-proxy（含 loopback，`<-loopback>`），
 *   CDP Fetch 那道按**页**装（ssrf-guard scope:'page'）—— Electron 的 context 里还有 NoDesign 自己的窗，
 *   整 context 装闸会把应用自己拦死。
 * - CDP 口只绑 127.0.0.1。它能控制整个应用，跟用户的 shell 同一个信任边界；没有令牌那一层（CDP 没有）。
 */
import { platform } from '../../runtime/platform.js';

export function desktopHostConfigured() {
  return !!(platform.isLocal && process.env.NODESIGN_DESKTOP_BRIDGE && process.env.NODESIGN_DESKTOP_CDP);
}

async function bridge(method, pathname, body) {
  const base = process.env.NODESIGN_DESKTOP_BRIDGE.replace(/\/+$/, '');
  const res = await fetch(base + pathname, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.NODESIGN_DESKTOP_BRIDGE_TOKEN || ''}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 就原样报 */ }
  if (!res.ok) throw new Error(`desktop bridge ${method} ${pathname} → ${res.status}: ${json?.error || text.slice(0, 200)}`);
  return json;
}

let browserPromise = null;   // 共用一条 CDP 连接（连一次几百毫秒，而且每连一次 playwright 都要把所有页 attach 一遍）

async function cdpBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b && b.isConnected()) return b;
    browserPromise = null;
  }
  browserPromise = (async () => {
    const { chromium } = await import('playwright');
    const b = await chromium.connectOverCDP(process.env.NODESIGN_DESKTOP_CDP, { timeout: 20_000 });
    b.on('disconnected', () => { browserPromise = null; });
    return b;
  })();
  return browserPromise;
}

/** 按标记 URL 找到 Electron 刚建的那一页（新建的 target 要几十毫秒才进 playwright 的清单） */
async function findPage(browser, marker, { timeoutMs = 5000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    for (const ctx of browser.contexts()) {
      const p = ctx.pages().find(pg => pg.url() === marker);
      if (p) return p;
    }
    await new Promise(r => setTimeout(r, 80));
  }
  throw new Error(`desktop view page not found within ${timeoutMs}ms (${marker})`);
}

/**
 * 起（或复用）一个项目的桌面视图，回 playwright 的 page。
 * @param {string} projectId
 * @param {{ proxyPort: number, viewport: {width:number,height:number} }} opts
 */
export async function openDesktopView(projectId, { proxyPort, viewport }) {
  const created = await bridge('POST', '/views', { projectId, proxyPort, viewport });
  const browser = await cdpBrowser();
  const page = await findPage(browser, created.marker);
  const context = page.context();
  // DPR 钉 1：HiDPI 屏（Windows 常见 125% / 150%）上截图会按 DPR 放大，坐标就不再 1:1。width/height 给 0 = 不改视口尺寸
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: 1, mobile: false }).catch(() => {});
  return { page, context, viewId: created.viewId, cdp };
}

export async function closeDesktopView(viewId) {
  try { await bridge('DELETE', `/views/${encodeURIComponent(viewId)}`); } catch (err) { console.warn('[browse/desktop] close view failed:', err.message); }
}
