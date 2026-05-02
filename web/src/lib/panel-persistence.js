/**
 * panel-persistence.js — FloatingPanel layout 持久化到 localStorage
 *
 * Canvas 焕新升级 F1.2（2026-05-02）。
 *
 * Schema：
 *   {
 *     version: 1,
 *     panels: {
 *       'chat':     { position: {x, y}, size: {width, height}, visible: true,  zIndex: 100 },
 *       'canvas':   { position, size, visible, zIndex },
 *       'inspect':  { ... },
 *       ...
 *     }
 *   }
 *
 * Key: `nodesign-layout-${projectId}` — per-project（不绑 session，切 session
 *      不重置 layout）
 *
 * 版本不兼容时返默认（不抛错），让 fallback 优雅。
 */

const SCHEMA_VERSION = 1;

function key(projectId) {
  return `nodesign-layout-${projectId || 'default'}`;
}

/**
 * 读取持久化的 layout。
 * 找不到 / schema 不兼容 / parse 失败 → 返 null（让调用方用默认）
 */
export function loadLayout(projectId) {
  try {
    const raw = localStorage.getItem(key(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.version !== SCHEMA_VERSION) return null;
    if (!parsed.panels || typeof parsed.panels !== 'object') return null;
    return parsed.panels;
  } catch {
    return null;
  }
}

/**
 * 保存 layout。失败 fail-soft（localStorage 满 / 隐私模式 disabled）
 */
export function saveLayout(projectId, panels) {
  try {
    const payload = { version: SCHEMA_VERSION, panels };
    localStorage.setItem(key(projectId), JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/**
 * 清空当前 project 的 layout（reset）
 */
export function clearLayout(projectId) {
  try {
    localStorage.removeItem(key(projectId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Merge 默认 layout 和 saved layout —— saved 覆盖 default 的同 id 字段。
 * 如果 saved 有 default 没有的 id（用户拖出来的额外 panel），保留。
 */
export function mergeLayouts(defaults, saved) {
  if (!saved) return { ...defaults };
  const out = { ...defaults };
  for (const id of Object.keys(saved)) {
    out[id] = { ...(defaults[id] || {}), ...saved[id] };
  }
  return out;
}
