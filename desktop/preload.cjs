// desktop/preload.cjs — 页面与桌面壳之间唯一的桥（09-07，设置页「关于」要的两件事）。
//
// 页面是 http://127.0.0.1 上的普通网页，安全模型不动：contextIsolation 开着、nodeIntegration 关着。
// 这里只暴露三个动词，都经 ipcMain.handle 在主进程里做，参数由主进程再校验一遍。
// ⚠️ 必须是 CommonJS（.cjs）：package.json 是 "type": "module"，而 Electron 的 sandbox preload 只吃 CJS。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nodesignDesktop', {
  /** 壳版本（跟 package.json 一致） */
  version: process.env.NODESIGN_DESKTOP_VERSION || '',
  /** 检查更新：返回 { message, available, latest } —— 页面自己显示，不弹系统对话框 */
  checkForUpdates: () => ipcRenderer.invoke('nd:check-updates'),
  /** 用系统文件管理器打开数据目录里的某个文件夹（只允许数据目录之内） */
  openPath: (p) => ipcRenderer.invoke('nd:open-path', String(p || '')),
  /** 用系统浏览器打开外链 */
  openExternal: (url) => ipcRenderer.invoke('nd:open-external', String(url || '')),
  /**
   * 选一个本地文件夹当项目（2026-09-07 存量仓库道）。返回绝对路径，用户取消返回 null。
   * 只出选择框、不动文件；真正建项目是页面拿路径去打 POST /api/local/projects/open-folder。
   */
  pickFolder: () => ipcRenderer.invoke('nd:pick-folder'),
  /**
   * 共视（09-08）：agent 的浏览器是壳里的一张原生视图，页面只负责说它该摆在哪、agent 在不在操作。
   *   place(projectId, rect|null)  rect 是页面 CSS px（getBoundingClientRect 那套），null = 收起（视图停到屏外，agent 照用）
   *   block(projectId, on)         on = agent 在操作，盖一层遮罩；人要接手先按停回合
   *   state(projectId)             { live, url, blocked }
   */
  browserView: {
    place: (projectId, rect) => ipcRenderer.invoke('nd:browser-place', String(projectId || ''), rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null),
    block: (projectId, on) => ipcRenderer.invoke('nd:browser-block', String(projectId || ''), !!on),
    state: (projectId) => ipcRenderer.invoke('nd:browser-state', String(projectId || '')),
  },
});
