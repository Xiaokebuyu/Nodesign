/**
 * lib/client-errors.js —— 前端错误上报与面包屑（2026-09-08 诊断埋点⑦⑧⑨）。
 *
 * ⑦ window.onerror / unhandledrejection → POST /api/me/client-issues 进问题库（source=client）。
 *    九处 catch(() => {}) 吞掉的不会到这里，但没被吞的、React 渲染炸的、Promise 没接的全会。
 *    同一条消息一次会话只报一次；一次会话最多 5 条；服务端每用户每天 20 条。
 * ⑧ 面包屑 crumb(name, data)：最近 30 个用户动作 / 关键步骤（删除四步等），随每条上报带上 ——
 *    「点了没反应」这一族看的就是「点了 → 请求发了 → 回来了 → 卡没了」哪一步没走到。
 * ⑨ 渲染健康：PerformanceObserver 数超过 200ms 的 long task，随上报带上；window.__ndPerf 里随时能看。
 */
import { jsonRequest } from './api.js';

const crumbs = [];
const CRUMB_CAP = 30;
const sent = new Set();
let sentCount = 0;
const perf = { longTasks: 0, longTaskMs: 0, worstMs: 0, since: Date.now() };

export function crumb(name, data = null) {
  crumbs.push({ t: Date.now(), name, ...(data ? { data: safe(data) } : {}) });
  if (crumbs.length > CRUMB_CAP) crumbs.shift();
}
export function recentCrumbs() { return crumbs.slice(); }
export function perfCounters() { return { ...perf }; }

function safe(v) {
  try { const s = JSON.stringify(v); return s.length > 300 ? `${s.slice(0, 300)}…` : JSON.parse(s); } catch { return String(v).slice(0, 300); }
}
function fmtCrumbs() {
  const now = Date.now();
  return crumbs.map((c) => `-${Math.round((now - c.t) / 1000)}s ${c.name}${c.data ? ' ' + JSON.stringify(c.data) : ''}`).join('\n');
}

export async function reportClientError(message, { stack = '', where = 'window' } = {}) {
  const summary = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (summary.length < 8 || sent.has(summary) || sentCount >= 5) return false;
  sent.add(summary); sentCount += 1;
  const route = typeof location !== 'undefined' ? location.pathname : '';
  const projectId = /\/projects\/([^/]+)/.exec(route)?.[1] || null;
  const detail = [
    `route: ${route}`, `ua: ${typeof navigator !== 'undefined' ? navigator.userAgent : ''}`,
    `perf: longTasks=${perf.longTasks} longTaskMs=${perf.longTaskMs} worst=${perf.worstMs}ms`,
    '', 'stack:', String(stack || '').slice(0, 2000), '', 'crumbs:', fmtCrumbs(),
  ].join('\n');
  try { await jsonRequest('POST', '/api/me/client-issues', { summary, detail, where, projectId }); return true; } catch { return false; }
}

let installed = false;
export function installClientErrorReporting() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => { reportClientError(e?.message || String(e?.error || 'error'), { stack: e?.error?.stack || `${e?.filename || ''}:${e?.lineno || ''}`, where: 'onerror' }); });
  window.addEventListener('unhandledrejection', (e) => { const r = e?.reason; reportClientError(r?.message || String(r || 'unhandled rejection'), { stack: r?.stack || '', where: 'unhandledrejection' }); });
  try {
    const po = new PerformanceObserver((list) => { for (const en of list.getEntries()) { if (en.duration >= 200) { perf.longTasks += 1; perf.longTaskMs += Math.round(en.duration); perf.worstMs = Math.max(perf.worstMs, Math.round(en.duration)); } } });
    po.observe({ entryTypes: ['longtask'] });
  } catch { /* 浏览器不支持 longtask 就没有这项 */ }
  window.__ndPerf = perf; window.__ndCrumbs = crumbs;
}
