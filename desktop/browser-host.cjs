// desktop/browser-host.cjs — 共视：agent 的浏览器在 Electron 里原生显示（2026-09-08 缝二）
//
// 服务端（server/engine/browse/desktop-host.js）经这里建视图，再用 playwright 走 CDP 操作同一页；
// 页面（BrowserWindow.jsx）经 preload 告诉这里视图该摆在窗里的哪个矩形、agent 在不在操作。
//
// 三件硬规矩（09-08 spike 实测，见 server/engine/browse/desktop-host.js 头注）：
//   1. 视图矩形是 16:9，zoomFactor = 矩形宽 / 1366 → 页面 innerWidth 恒 1366，agent 的坐标 1:1。
//      Chromium 的 zoom 按 origin 记、换站归 1，所以每次 did-navigate 都重设。
//   2. 没摆上桌面的视图**停在屏外**（x = -20000，1366×768 原尺寸），不能缩成 0×0：0×0 的页 CDP 截图会挂死。
//   3. 遮罩（透明 WebContentsView）盖在视图上 = agent 在操作、人先按停才能接手；渲染层按自己的在飞回合状态开关。
//
// 安全边界：bridge 只绑 127.0.0.1 + Bearer 令牌（每次启动随机）；CDP 口也只绑 127.0.0.1，没有令牌那一层
// （Chromium 没有），它跟用户的 shell 同一个信任边界。partition `persist:nd-browser` 所有项目共用（登录态共用）。
// ⚠️ 必须是 CommonJS（.cjs）：main.js 是 ESM，但这份要能被 require 也能被 import。
const { WebContentsView, session, ipcMain } = require('electron');
const http = require('node:http');
const crypto = require('node:crypto');

const PARTITION = 'persist:nd-browser';
const PARK = { x: -20000, y: 0 };   // 屏外停车位
const BLOCKER_HTML = 'data:text/html,' + encodeURIComponent('<!doctype html><html><body style="margin:0;background:transparent;cursor:not-allowed" title="agent 在操作，先按停才能接手"></body></html>');

/**
 * @param {{ getWindow: () => import('electron').BrowserWindow|null, log: (s:string)=>void, cdpPort: number }} deps
 */
function createBrowserHost({ getWindow, log, cdpPort }) {
  const token = crypto.randomBytes(18).toString('base64url');
  /** projectId → { view, blocker, viewport, rect:{x,y,width,height}|null, blocked:boolean, attached:boolean, id } */
  const views = new Map();
  const byId = new Map();
  /** 页面先于视图到的意愿（视图还没建就先说了要摆哪 / 要不要遮） */
  const wishes = new Map();   // projectId → { rect, blocked }
  let proxyApplied = null;

  const ses = () => session.fromPartition(PARTITION);

  const clampZoom = (z) => Math.max(0.2, Math.min(3, z));

  /**
   * 让页面的 CSS 视口等于 entry.viewport（工具层写死的 1366×768，坐标契约就靠它）。
   *
   * ⛔ **判据是页面自己量的 innerWidth，不是 getZoomFactor**（2026-09-10 改）。
   *    原来那版拿 `getZoomFactor()` 回读对账，站主机器上的日志（desktop.log，09-08 起每一场都有）
   *    是这样的：`place 1068×600` → `zoom 期望 0.782 实际 0.851，重设` → 再读还是 0.851……
   *    期望值随 rAF 送来的新矩形一路变（1.000/0.782/0.786/0.791/0.816/0.824/0.835），回读值咬死不动，
   *    **一次都没对上过**。实际÷期望 ≈ 1.25 = 他那块屏的 Windows 缩放 —— set 和 get 差着一个
   *    display scale factor。于是视口从来不是 1366：模型收到的图是按另一个宽度布局的（画面缩在一角），
   *    frame 又按 1366 判界（坐标点不着）。
   *    对着一个会撒谎的读数纠错，纠不出真相；改成对着**我们真正关心的那个数**纠。
   * ⭐ 学到的偏差存在 entry.zoomBias 上：下次矩形一变就直接带上，不用每次重新收敛。
   */
  function applyZoom(entry, verify = 2) {
    const wc = entry.view.webContents;
    if (wc.isDestroyed()) return;
    const w = (entry.bounds && entry.bounds.width) || entry.viewport.width;
    const zoom = clampZoom((w / entry.viewport.width) * (entry.zoomBias || 1));
    entry.zoomApplied = zoom;   // 基准用**我们设下去的值**，不回读（回读那个数不可信）
    try { wc.setZoomFactor(zoom); } catch { /* 页面还没就绪时会抛，下面复查再来 */ }
    if (verify > 0) setTimeout(() => checkViewport(entry, verify), 300);
  }

  /** 复查：页面量到的视口跟要的差多少，就按比例把 zoom 拨过去（页面没就绪时 setZoomFactor 也会静默不生效，这条同时兜住它） */
  function checkViewport(entry, left) {
    const wc = entry.view.webContents;
    if (wc.isDestroyed()) return;
    wc.executeJavaScript('({w:window.innerWidth,h:window.innerHeight})', true).then((vp) => {
      if (!vp || !(vp.w > 0)) return;
      const want = entry.viewport.width;
      entry.cssViewport = { width: vp.w, height: vp.h };
      if (Math.abs(vp.w - want) <= Math.max(2, want * 0.01)) return;    // 1% 以内算到位
      const base = entry.zoomApplied || 1;
      const next = clampZoom(base * (vp.w / want));
      entry.zoomBias = clampZoom(next / ((entry.bounds && entry.bounds.width ? entry.bounds.width : want) / want));
      log(`[browser-host] viewport ${entry.projectId} 实测 ${vp.w}×${vp.h}（要 ${want}×${entry.viewport.height}）→ zoom ${base.toFixed(3)}→${next.toFixed(3)}`);
      entry.zoomApplied = next;
      try { wc.setZoomFactor(next); } catch { return; }
      if (left > 1) setTimeout(() => checkViewport(entry, left - 1), 300);
    }).catch(() => { /* 导航中读不到，下一次 layout/did-navigate 再来 */ });
  }

  function layout(entry) {
    const win = getWindow();
    const alive = !!win && !win.isDestroyed();
    const { view, blocker } = entry;
    // ⭐ bounds **先定下来，而且不看有没有窗**（2026-09-10）：setBounds 不需要窗，只有
    //    addChildView 需要。原来整个函数在没窗时早退 —— 新建的 WebContentsView 默认
    //    bounds 是 0×0，页面就按 0 宽布局 —— 这正是问题库里 09-08 那条 "Cannot take
    //    screenshot with 0 width" 的形状（没在站主机器上复核过，但这条路确实能走到）。
    //    而 dom-ready/did-finish-load 上挂的 applyZoom 照跑，于是 zoom 与 bounds 出自两处。
    const z = alive ? (win.webContents.getZoomFactor() || 1) : 1;   // 页面 CSS px → DIP。主窗倍率被 main.js 钉在 1，这里只是防御
    const r = entry.rect
      ? { x: Math.round(entry.rect.x * z), y: Math.round(entry.rect.y * z), width: Math.round(entry.rect.width * z), height: Math.round(entry.rect.height * z) }
      : { ...PARK, width: entry.viewport.width, height: entry.viewport.height };
    view.setBounds(r);
    entry.bounds = r;          // applyZoom 只认这个 —— 视口 = bounds ÷ zoom，两个数出自同一次 layout
    applyZoom(entry);
    if (!alive) return;
    if (!entry.attached) { win.contentView.addChildView(view); entry.attached = true; }
    if (entry.rect && entry.blocked) {
      if (!entry.blockerAttached) { win.contentView.addChildView(blocker); entry.blockerAttached = true; }
      blocker.setBounds(r);
    } else if (entry.blockerAttached) { win.contentView.removeChildView(blocker); entry.blockerAttached = false; }
  }

  async function createView({ projectId, proxyPort, viewport }) {
    const vp = { width: Number(viewport?.width) || 1366, height: Number(viewport?.height) || 768 };
    const existing = views.get(projectId);
    if (existing && !existing.view.webContents.isDestroyed()) return { viewId: existing.id, marker: existing.marker, reused: true };
    const s = ses();
    if (proxyPort && proxyApplied !== proxyPort) {
      // 出网闸在服务端的代理层；<-loopback> = 连 localhost 也走代理，让闸看见（跟 headless 那条的 bypass:'' 同义）
      await s.setProxy({ proxyRules: `http://127.0.0.1:${proxyPort}`, proxyBypassRules: '<-loopback>' });
      proxyApplied = proxyPort;
    }
    const view = new WebContentsView({ webPreferences: { session: s, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false } });
    const blocker = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    blocker.setBackgroundColor('#00000000');
    blocker.webContents.loadURL(BLOCKER_HTML).catch(() => {});
    const id = crypto.randomBytes(6).toString('hex');
    const marker = `about:blank#nd-${projectId}-${id}`;
    const wish = wishes.get(projectId) || {};
    const entry = { id, projectId, view, blocker, viewport: vp, rect: wish.rect || null, blocked: !!wish.blocked, attached: false, blockerAttached: false, marker };
    views.set(projectId, entry); byId.set(id, entry);
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) wc.loadURL(url).catch(() => {}); return { action: 'deny' }; });
    wc.on('did-navigate', () => applyZoom(entry));
    wc.on('did-navigate-in-page', () => applyZoom(entry));
    wc.on('dom-ready', () => applyZoom(entry));
    wc.on('did-finish-load', () => applyZoom(entry));
    wc.on('destroyed', () => { if (views.get(projectId) === entry) views.delete(projectId); byId.delete(id); });
    layout(entry);
    await wc.loadURL(marker).catch(() => {});
    log(`[browser-host] view ${id} for ${projectId} (proxy :${proxyPort || '-'})`);
    return { viewId: id, marker, reused: false };
  }

  function destroyView(id) {
    const entry = byId.get(id);
    if (!entry) return false;
    const win = getWindow();
    try { if (win && !win.isDestroyed()) { if (entry.attached) win.contentView.removeChildView(entry.view); if (entry.blockerAttached) win.contentView.removeChildView(entry.blocker); } } catch { /* */ }
    try { entry.view.webContents.close(); } catch { /* */ }
    try { entry.blocker.webContents.close(); } catch { /* */ }
    views.delete(entry.projectId); byId.delete(id);
    log(`[browser-host] view ${id} closed`);
    return true;
  }

  function destroyAll() { for (const id of [...byId.keys()]) destroyView(id); }

  // ── 页面 → 主进程：摆哪 / 遮不遮 ──
  ipcMain.handle('nd:browser-place', (_e, projectId, rect) => {
    const pid = String(projectId || '');
    const r = rect && Number.isFinite(rect.width) && rect.width > 0 ? { x: +rect.x, y: +rect.y, width: +rect.width, height: +rect.height } : null;
    const prev = wishes.get(pid)?.rect || null;
    wishes.set(pid, { ...(wishes.get(pid) || {}), rect: r });
    const entry = views.get(pid);
    if (entry) { entry.rect = r; layout(entry); }
    // 只记 摆上/收起 的切换，不记逐帧的位移（09-08 诊断埋点⑥）
    if (!!prev !== !!r) log(`[browser-host] place ${pid} ${r ? `${r.width}×${r.height}@${r.x},${r.y}` : 'null（停到屏外）'} live=${!!entry}`);
    return { ok: true, live: !!entry };
  });
  ipcMain.handle('nd:browser-block', (_e, projectId, on) => {
    const pid = String(projectId || '');
    const was = !!wishes.get(pid)?.blocked;
    wishes.set(pid, { ...(wishes.get(pid) || {}), blocked: !!on });
    const entry = views.get(pid);
    if (entry) { entry.blocked = !!on; layout(entry); }
    if (was !== !!on) log(`[browser-host] block ${pid} ${on ? 'on（agent 在操作）' : 'off（可接手）'} live=${!!entry}`);
    return { ok: true, live: !!entry };
  });
  // 接手：把键盘焦点交给视图（否则按了手形按钮之后敲键盘打进的是主窗口）
  ipcMain.handle('nd:browser-focus', (_e, projectId) => {
    const entry = views.get(String(projectId || ''));
    if (!entry || entry.view.webContents.isDestroyed()) { log(`[browser-host] focus ${projectId} 没有视图`); return { ok: false }; }
    try { entry.view.webContents.focus(); } catch { /* */ }
    log(`[browser-host] focus ${projectId}`);
    return { ok: true };
  });
  ipcMain.handle('nd:browser-state', (_e, projectId) => {
    const entry = views.get(String(projectId || ''));
    return entry ? { live: true, url: entry.view.webContents.getURL(), blocked: entry.blocked } : { live: false };
  });

  // 主窗自己的缩放变了（正常不会：main.js 把倍率钉在 1，这里兜 zoom-changed 拨回那一瞬）→ 重排
  function onWindowReady(win) {
    win.webContents.on('zoom-changed', () => { for (const e of views.values()) layout(e); });
    win.on('resize', () => { for (const e of views.values()) layout(e); });
    for (const e of views.values()) layout(e);
  }

  // ── 服务端 → 主进程：bridge（127.0.0.1，Bearer）──
  function start() {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        const auth = String(req.headers.authorization || '');
        if (auth !== `Bearer ${token}`) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }
        let body = '';
        req.on('data', (d) => { body += d; if (body.length > 65536) req.destroy(); });
        req.on('end', async () => {
          const reply = (code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
          try {
            const j = body ? JSON.parse(body) : {};
            const m = req.url.match(/^\/views(?:\/([a-f0-9]+))?$/);
            if (!m) return reply(404, { error: 'no such route' });
            if (req.method === 'POST' && !m[1]) return reply(200, await createView(j));
            if (req.method === 'DELETE' && m[1]) return reply(200, { ok: destroyView(m[1]) });
            if (req.method === 'GET' && !m[1]) {
              return reply(200, { views: [...views.values()].map(e => {
                const dead = e.view.webContents.isDestroyed();
                const bounds = e.view.getBounds();
                const zoom = dead ? null : e.view.webContents.getZoomFactor();
                // ⭐ cssViewport = bounds ÷ zoom —— 这就是页面自己量到的 innerWidth/innerHeight，
                //    也是 agent 那边坐标契约的那个数。它不等于 viewport 就是共视对不上位，
                //    别再靠肉眼看截图猜（09-10：「画面缩到一角」「坐标定位不到」是同一个数错了）。
                const cssViewport = e.cssViewport || ((zoom && bounds.width) ? { width: Math.round(bounds.width / zoom), height: Math.round(bounds.height / zoom) } : null);
                return { id: e.id, projectId: e.projectId, url: e.view.webContents.getURL(), placed: !!e.rect, rect: e.rect, bounds, zoom, cssViewport, want: e.viewport, ok: !!cssViewport && cssViewport.width === e.viewport.width, blocked: e.blocked };
              }) });
            }
            // 诊断：这张视图现在长什么样（PNG base64）。站主远程看共视对不对位时用
            if (req.method === 'GET' && m[1]) { const e = byId.get(m[1]); if (!e) return reply(404, { error: 'no such view' }); const img = await e.view.webContents.capturePage(); return reply(200, { png: img.toPNG().toString('base64'), size: img.getSize() }); }
            reply(405, { error: 'method' });
          } catch (err) { reply(500, { error: err.message }); }
        });
      });
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const { port } = srv.address();
        resolve({ bridgeUrl: `http://127.0.0.1:${port}`, token, cdpUrl: `http://127.0.0.1:${cdpPort}` });
      });
    });
  }

  return { start, onWindowReady, destroyAll, views };
}

/** CDP 端口：env 指定，否则 9300~9899 里随机一个（不能在 app ready 之后再挑，那时开关已经读过了） */
function pickCdpPort() {
  const want = Number(process.env.NODESIGN_DESKTOP_CDP_PORT);
  if (Number.isInteger(want) && want > 1024) return want;
  return 9300 + crypto.randomInt(600);
}

module.exports = { createBrowserHost, pickCdpPort, PARTITION };
