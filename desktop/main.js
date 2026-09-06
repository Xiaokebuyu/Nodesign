/**
 * desktop/main.js — Windows 桌面版的 Electron 主进程。
 *
 * 它跟 bin/nodesign.js 是同一件事的两个外壳：都用 bin/supervisor.js 拉起 server/index.js，
 * 都等 /api/health 通。区别只在起来之后拿这个 URL 干什么 —— 命令行版开系统浏览器，
 * 这里加载进 BrowserWindow。所有配置决策仍在 server/runtime/profile.js，这里一份都不复制。
 *
 * ## 三条不显然的决定
 *
 * 1. **服务端跑在子进程里，不跑在主进程里。** 主进程崩了整个应用就没了，而服务端会因为
 *    "保存并重启"（退出码 75）正常地反复重启。分开之后重启对窗口是透明的：页面自己重连，
 *    窗口不闪。代价是多一个进程，值。
 *
 * 2. **子进程用安装包里带的 node.exe 跑，不用 Electron 的 node 模式。** Electron 的 Node 版本
 *    跟着 Electron 走，服务端要的是一个确定的 Node（node:sqlite 要 ≥ 22.13）；带一份真 node
 *    （resources/node/node.exe，desktop.yml 抓的）之后两边彻底解耦，Electron 升级不牵连服务端。
 *    开发态没有那份 node.exe，用 PATH 里的 node。
 *
 * 3. **数据目录跟 npx 版共用同一个 ~/.nodesign。** 同一个人可能今天用命令行、明天装桌面版，
 *    项目和产物应该是同一份，不该因为换了外壳就看不见自己的东西。
 *
 * ⚠️ 打包用 asar: false。服务端要 spawn 自己、要加载原生模块、要读写工作区文件，
 *    asar 是只读虚拟包，这几件事在里面全是坑。少一层压缩换掉一整类问题。
 */

import { app, BrowserWindow, Menu, Tray, dialog, shell, nativeImage, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateCheckMessage } from './update-message.js';
import { resolveWindowBounds, MIN_SIZE } from './window-state.js';

import {
  PortBusyError,
  createSupervisor,
  pickPort,
  waitHealth,
} from '../bin/supervisor.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根 / 安装目录（asar:false，所以 getAppPath() 就是真目录） */
const appRoot = app.isPackaged ? app.getAppPath() : path.resolve(here, '..');
const serverEntry = path.join(appRoot, 'server', 'index.js');

const HOST = '127.0.0.1';

let win = null;
let splash = null;
let tray = null;
let sup = null;
let appUrl = null;
let quitting = false;

// 单实例：第二次双击图标不该再起一份服务端（两份抢同一个 sqlite 是数据事故），
// 应该把已经开着的那扇窗拿到前面来。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
  app.whenReady().then(boot).catch(fatal);
}

async function boot() {
  createSplash();

  const env = { ...process.env };
  env.NODESIGN_PROFILE = env.NODESIGN_PROFILE || 'local';
  env.NODESIGN_HOST = HOST;
  env.NODESIGN_OPEN = '0';            // 浏览器由我们开，服务端别自己开

  let port;
  try {
    port = await pickPort({ host: HOST, wanted: env.PORT ? Number(env.PORT) : null });
  } catch (e) {
    if (!(e instanceof PortBusyError)) throw e;
    return fatal(new Error(`${e.message}\n\n关掉占用它的程序，或在设置里换一个端口。`));
  }
  env.PORT = String(port);
  appUrl = `http://${HOST}:${port}/`;

  // 服务端输出写进数据目录的日志文件（Electron 窗口进程没有控制台，inherit 等于丢掉）。
  // 用户报问题时让他把这个文件发过来；文件超过 5MB 起动时滚一份 .old
  const dataDir = env.NODESIGN_DATA_DIR || path.join(app.getPath('home'), '.nodesign');
  openDesktopLog(dataDir);
  windowStatePath = path.join(dataDir, 'window.json');
  const logFd = openServerLog(dataDir);
  sup = createSupervisor({
    serverEntry,
    env,
    runtime: serverRuntime(),
    stdio: ['ignore', logFd, logFd],
    onRestart: () => log('服务端请求重启，重新拉起…'),
    onExit: (code, _signal, err) => {
      // 正常退出（我们主动停的）不弹窗；异常退出要让用户知道，别留一扇空白窗
      if (quitting) return;
      fatal(new Error(err ? `服务端起不来：${err.message}` : `服务端意外退出（退出码 ${code}）。`));
    },
  });
  sup.start();

  const ok = await waitHealth(appUrl, { timeoutMs: 60_000, alive: () => sup.running });
  if (!ok) return fatal(new Error('服务端 60 秒内没有就绪。'));

  createMainWindow();
  createTray();
  setupUpdater();
}

/** <数据目录>/logs/server.log 的文件描述符，给子进程当 stdout/stderr。开不了就退回 'ignore'（别因为日志起不来） */
function openServerLog(dataDir) {
  try {
    const dir = path.join(dataDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'server.log');
    try { if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.old`); } catch { /* 没有就没有 */ }
    const fd = fs.openSync(file, 'a');
    fs.writeSync(fd, `\n===== NoDesign ${app.getVersion()} 启动 ${new Date().toISOString()} =====\n`);
    return fd;
  } catch (err) {
    log(`打不开服务端日志文件：${err.message}`);
    return 'ignore';
  }
}

/** 服务端的运行时：打包后是 resources/node/node.exe；开发态用 PATH 里的 node（NODESIGN_NODE 可指定） */
function serverRuntime() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
  return process.env.NODESIGN_NODE || 'node';
}

/* ── 窗口 ─────────────────────────────────────────────────────────── */

// 起动画：服务端首次启动要建库、探能力，冷启动能到十几秒。这段时间没有窗口
// 用户会以为没点上，又双击一次（单实例锁挡得住起第二份，但挡不住他觉得坏了）。
function createSplash() {
  splash = new BrowserWindow({
    width: 420, height: 260, frame: false, resizable: false,
    center: true, show: true, backgroundColor: '#faf8f4',
  });
  splash.loadFile(path.join(here, 'splash.html'));
}

// 窗口大小 / 位置记在数据目录（window.json）。⛔ 别写死 1440×900：Electron 不按屏幕裁，笔记本上底下一截会落在屏幕外
let windowStatePath = null;
function readWindowState() {
  try { return JSON.parse(fs.readFileSync(windowStatePath, 'utf8')); } catch { return null; }
}
function saveWindowState() {
  if (!win || !windowStatePath) return;
  try {
    const b = win.getNormalBounds();   // 最大化时是还原后的那个框
    fs.writeFileSync(windowStatePath, JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch (e) { log(`记不下窗口位置：${e.message}`); }
}

function createMainWindow() {
  const bounds = resolveWindowBounds(readWindowState(), [screen.getPrimaryDisplay(), ...screen.getAllDisplays().filter((d) => d.id !== screen.getPrimaryDisplay().id)].map((d) => d.workArea));
  win = new BrowserWindow({
    width: bounds.width, height: bounds.height, minWidth: MIN_SIZE.width, minHeight: MIN_SIZE.height,
    ...(bounds.x != null ? { x: bounds.x, y: bounds.y } : { center: true }),
    show: false, backgroundColor: '#faf8f4',
    webPreferences: {
      // 页面是 http://127.0.0.1 上的普通网页，保持默认的浏览器安全模型：
      // 不开 nodeIntegration，不关 contextIsolation。它要的能力全走服务端 HTTP。
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => {
    splash?.destroy(); splash = null;
    if (bounds.maximized) win.maximize();
    win.show();
  });
  let saveTimer = null;
  const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveWindowState, 400); };
  win.on('resize', scheduleSave); win.on('move', scheduleSave);
  win.on('maximize', scheduleSave); win.on('unmaximize', scheduleSave);

  // 站外链接（用户产物里的外链、文档链接）交给系统浏览器，别在应用里开一扇没有地址栏的窗
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(appUrl)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });

  // 关窗不退出：托盘还在，符合 Windows 上常驻应用的习惯。真退出走托盘菜单或 app.quit()
  win.on('close', (e) => {
    saveWindowState();
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });

  win.loadURL(appUrl);
}

function showMainWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/* ── 托盘 ─────────────────────────────────────────────────────────── */

function createTray() {
  const icon = nativeImage.createFromPath(path.join(here, 'assets', 'tray.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('NoDesign');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 NoDesign', click: showMainWindow },
    { label: '在浏览器中打开', click: () => shell.openExternal(appUrl) },
    { type: 'separator' },
    { label: '检查更新', click: () => checkForUpdates({ silent: false }) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('click', showMainWindow);
}

/* ── 更新 ─────────────────────────────────────────────────────────── */

let updater = null;

/**
 * electron-updater：有 blockmap 对得上就下差分，对不上（比如跨了 Electron 大版本）
 * 自动退回下整包。所以"完整包更新"和"差分更新"不是两套配置，是同一套的两条路径。
 *
 * 开发态没有 latest.yml 可查，直接不装 —— 否则每次起都报一条查不到更新的错。
 */
let updaterState = 'init';   // 'init' | 'dev' | 'ready' | 'failed: …'
function setupUpdater() {
  if (!app.isPackaged) { updaterState = 'dev'; return; }
  import('electron-updater').then((mod) => {
    // ⛔ electron-updater 是 CJS，autoUpdater 是 Object.defineProperty 的 getter 导出：ESM 动态 import 后
    // 具名解构拿到 undefined（09-06 站主装 0.0.11 点「检查更新」看到的就是这一下）。从 default 上取。
    const autoUpdater = mod.default?.autoUpdater ?? mod.autoUpdater;
    if (!autoUpdater) throw new Error('electron-updater 没导出 autoUpdater（keys: ' + Object.keys(mod).join(',') + '）');
    updater = autoUpdater;
    updaterState = 'ready';
    updater.logger = { info: (m) => log(`[updater] ${m}`), warn: (m) => log(`[updater] ⚠ ${m}`), error: (m) => log(`[updater] ✗ ${m}`), debug: () => {} };
    updater.autoDownload = true;          // 后台下，别打断用户
    updater.autoInstallOnAppQuit = true;  // 用户不点也会在下次退出时装上

    updater.on('update-downloaded', (info) => {
      dialog.showMessageBox(win, {
        type: 'info',
        buttons: ['立即重启更新', '下次启动时更新'],
        defaultId: 0,
        title: '有新版本',
        message: `NoDesign ${info.version} 已下载完成。`,
        detail: '重启大约几秒钟，正在跑的会话会被中断。',
      }).then(({ response }) => { if (response === 0) quitAndInstall(); });
    });
    updater.on('error', (e) => log(`更新检查失败：${e?.message || e}`));

    checkForUpdates({ silent: true });
    setInterval(() => checkForUpdates({ silent: true }), 6 * 60 * 60 * 1000).unref?.();
  }).catch((e) => { updaterState = `failed: ${e.message}`; log(`更新模块加载失败：${e.stack || e.message}`); });
}

function checkForUpdates({ silent }) {
  if (!updater) {
    if (!silent) {
      const why = updaterState === 'dev' ? '开发模式下不检查更新。' : updaterState === 'init' ? '更新模块还没加载完，稍等再点。' : `更新模块没起来：${updaterState}\n\n日志在 ${logPath || '数据目录/logs/'}`;
      dialog.showMessageBox(win, { type: updaterState.startsWith('failed') ? 'error' : 'info', message: why });
    }
    return;
  }
  updater.checkForUpdates().then((r) => {
    log(`[updater] 检查结果：已发布最新 ${r?.updateInfo?.version ?? '?'}，本机 ${app.getVersion()}，${r?.isUpdateAvailable ? '有更新' : '无更新'}`);
    if (silent) return;
    // ⛔ 三种结果都要说话。09-07 站主装着比已发布版本新的草稿包点「检查更新」，没有任何反应 ——
    // 原来只在"版本号相等"时弹"已是最新"，服务器版本比本机旧那条路什么都不说。
    dialog.showMessageBox(win, { type: 'info', message: updateCheckMessage(r, app.getVersion()) });
  }).catch((e) => { if (!silent) dialog.showMessageBox(win, { type: 'error', message: `检查更新失败：${e.message}` }); });
}

// 装更新之前必须先把服务端停干净：sqlite 还开着的时候换文件，轻则更新失败重则库损坏
async function quitAndInstall() {
  quitting = true;
  await sup?.stop();
  updater.quitAndInstall();
}

/* ── 退出 ─────────────────────────────────────────────────────────── */

app.on('before-quit', (e) => {
  if (quitting || !sup?.running) return;
  e.preventDefault();
  quitting = true;
  sup.stop().then(() => app.quit());
});

app.on('window-all-closed', () => { /* 托盘常驻，不在这里退出 */ });

let logFile = null; let logPath = null;
/** 主进程日志：控制台一份（开发态看得见），文件一份（<数据目录>/logs/desktop.log，装好的应用没有控制台） */
function log(msg) {
  const line = `${new Date().toISOString()} [nodesign-desktop] ${msg}`;
  console.log(line);
  try { if (logFile != null) fs.writeSync(logFile, line + '\n'); } catch { /* 日志写不进不能影响正事 */ }
}
function openDesktopLog(dataDir) {
  try {
    const dir = path.join(dataDir, 'logs'); fs.mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, 'desktop.log');
    try { if (fs.statSync(logPath).size > 2 * 1024 * 1024) fs.renameSync(logPath, `${logPath}.old`); } catch { /* */ }
    logFile = fs.openSync(logPath, 'a');
    log(`NoDesign ${app.getVersion()} 启动，packaged=${app.isPackaged}`);
  } catch (err) { console.log(`[nodesign-desktop] 打不开主进程日志：${err.message}`); }
}

let fatalShown = false;
function fatal(err) {
  log(`启动失败：${err?.stack || err}`);
  // 同一次失败会从两条路到这里（health 超时 + 子进程 onExit），只弹一次
  if (fatalShown) return;
  fatalShown = true;
  splash?.destroy(); splash = null;
  dialog.showErrorBox('NoDesign 启动失败', String(err?.message || err));
  quitting = true;
  // ⚠️ 不能写 sup?.stop().finally(...)：sup 为空时可选链把整条表达式短路成 undefined，
  // finally 根本不会调，app.exit 也不会 —— 端口被占那条路就是 sup 还没建的时候来的。
  (sup ? sup.stop() : Promise.resolve()).finally(() => app.exit(1));
}
