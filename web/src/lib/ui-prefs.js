// web/src/lib/ui-prefs.js — 界面体验偏好（字体 / 缩放），存 localStorage，起动时和改动时立刻应用到根节点。
// 不经服务端：这是这台浏览器（桌面版 = 这台机器）的事，改了要立刻看到，不该等一个请求。
const KEY = 'nd.ui';
export const FONTS = [
  { id: 'kai', label: '楷体（默认）' },
  { id: 'sans', label: '系统无衬线' },
];
export const ZOOMS = [90, 100, 110, 125];

const DEFAULTS = { font: 'kai', zoom: 100 };

export function loadUiPrefs() {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) || '{}') || {}) }; } catch { return { ...DEFAULTS }; }
}

export function saveUiPrefs(patch) {
  const next = { ...loadUiPrefs(), ...patch };
  if (!FONTS.some((f) => f.id === next.font)) next.font = DEFAULTS.font;
  if (!ZOOMS.includes(Number(next.zoom))) next.zoom = DEFAULTS.zoom;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* 存不上就只管这一次 */ }
  applyUiPrefs(next);
  return next;
}

/** 字体走根节点 data-font（globals.css 的 --nd-font-ui 按它切）；缩放走 CSS zoom（Chromium 认，整站按比例） */
export function applyUiPrefs(p = loadUiPrefs()) {
  const root = document.documentElement;
  if (p.font === 'kai') delete root.dataset.font; else root.dataset.font = p.font;
  root.style.zoom = p.zoom === 100 ? '' : `${p.zoom}%`;
}
