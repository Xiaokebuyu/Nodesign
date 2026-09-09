// web/src/lib/ui-prefs.js — 界面体验偏好（字体），存 localStorage，起动时和改动时立刻应用到根节点。
// 不经服务端：这是这台浏览器（桌面版 = 这台机器）的事，改了要立刻看到，不该等一个请求。
//
// ⛔ 「界面缩放」已整体拿掉（2026-09-09，站主定：桌面版任何非 100% 的显示都会让输入框和悬浮工具栏
// 溢出画面，Windows 110% 实报）。根节点上的 CSS zoom 曾经按这里的 `zoom` 偏好设，老用户的
// localStorage 里还存着 110/125 —— 所以 applyUiPrefs 每次都把它擦回空，saveUiPrefs 也不再把它写回去；
// 光删入口不归零，已经调过的人永远回不来。桌面壳那一层（Electron zoomFactor）09-07 已同样钉死在 1。
const KEY = 'nd.ui';
export const FONTS = [
  { id: 'kai', label: '楷体（默认）' },
  { id: 'sans', label: '系统无衬线' },
];

const DEFAULTS = { font: 'kai' };

export function loadUiPrefs() {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
    delete stored.zoom;   // 历史字段，读到也当没有
    return { ...DEFAULTS, ...stored };
  } catch { return { ...DEFAULTS }; }
}

export function saveUiPrefs(patch) {
  const next = { ...loadUiPrefs(), ...patch };
  delete next.zoom;
  if (!FONTS.some((f) => f.id === next.font)) next.font = DEFAULTS.font;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* 存不上就只管这一次 */ }
  applyUiPrefs(next);
  return next;
}

/** 字体走根节点 data-font（globals.css 的 --nd-font-ui 按它切）。CSS zoom 一律擦掉（见文件头） */
export function applyUiPrefs(p = loadUiPrefs()) {
  const root = document.documentElement;
  if (p.font === 'kai') delete root.dataset.font; else root.dataset.font = p.font;
  if (root.style.zoom) root.style.zoom = '';
}
