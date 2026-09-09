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

  function applyZoom(entry, retry = true) {
    const wc = entry.view.webContents;
    if (wc.isDestroyed()) return;
    const w = entry.rect ? entry.rect.width : entry.viewport.width;
    const zoom = Math.max(0.2, Math.min(3, w / entry.viewport.width));
    try { wc.setZoomFactor(zoom); } catch { /* 页面还没就绪时会抛，下面复查再来 */ }
    // 复查（09-08 晚站主实报「内容缩在一角」）：页面没就绪时 setZoomFactor 静默不生效，而页面这头只在矩形变了才再发 place；
    // 300ms 后读回来对一次，不对就再设一次，再不对留给 did-navigate / did-finish-load
    if (!retry) return;
    setTimeout(() => {
      if (wc.isDestroyed()) return;
      let got = null; try { got = wc.getZoomFactor(); } catch { return; }
      if (Math.abs(got - zoom) > 0.01) { log(`[browser-host] zoom ${entry.projectId} 期望 ${zoom.toFixed(3)} 实际 ${got.toFixed(3)}，重设`); applyZoom(entry, false); }
    }, 300);
  }

  function layout(entry) {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    const { view, blocker } = entry;
    if (!entry.attached) { win.contentView.addChildView(view); entry.attached = true; }
    if (entry.rect) {
      const z = win.webContents.getZoomFactor() || 1;   // 页面 CSS px → DIP。主窗倍率被 main.js 钉在 1（界面缩放 09-07/09-09 两层都拿掉了），这里只是防御
      const r = { x: Math.round(entry.rect.x * z), y: Math.round(entry.rect.y * z), width: Math.round(entry.rect.width * z), height: Math.round(entry.rect.height * z) };
      view.setBounds(r);
      applyZoom(entry);
      if (entry.blocked) {
        if (!entry.blockerAttached) { win.contentView.addChildView(blocker); entry.blockerAttached = true; }
        blocker.setBounds(r);
      } else if (entry.blockerAttached) { win.contentView.removeChildView(blocker); entry.blockerAttached = false; }
    } else {
      view.setBounds({ ...PARK, width: entry.viewport.width, height: entry.viewport.height });
      applyZoom(entry);
      if (entry.blockerAttached) { win.contentView.removeChildView(blocker); entry.blockerAttached = false; }
    }
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
            if (req.method === 'GET' && !m[1]) return reply(200, { views: [...views.values()].map(e => ({ id: e.id, projectId: e.projectId, url: e.view.webContents.getURL(), placed: !!e.rect, rect: e.rect, bounds: e.view.getBounds(), zoom: e.view.webContents.isDestroyed() ? null : e.view.webContents.getZoomFactor(), blocked: e.blocked })) });
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
