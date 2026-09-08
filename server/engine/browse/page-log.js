/**
 * engine/browse/page-log.js —— 常驻浏览器每个项目一本页面日志（2026-09-08 诊断埋点）：
 * console（warn/error 级）、pageerror、requestfailed、>=400 的响应。只记摘要，每项目 300 条。
 * 挂在 registry 把 entry 放进 live 表的那一处；页关了日志留着（关了之后用户来问「刚才怎么了」才是常态）。
 * 读者：mcp-server 的 browser_log / browser_status。
 */
const CAP = 300;
const logs = new Map();   // projectId → { items: [], lastError: null, attachedAt }

function bucket(projectId) {
  let b = logs.get(projectId);
  if (!b) { b = { items: [], lastError: null, attachedAt: new Date().toISOString() }; logs.set(projectId, b); if (logs.size > 20) logs.delete(logs.keys().next().value); }
  return b;
}
function push(b, item) {
  b.items.push({ ts: new Date().toISOString(), ...item });
  if (b.items.length > CAP) b.items.shift();
  if (item.level === 'error') b.lastError = { ts: b.items[b.items.length - 1].ts, kind: item.kind, text: item.text };
}
const clip = (s, n = 300) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t; };

/** 幂等：同一 page 只挂一次（page 对象上打标） */
export function attachPageLog(projectId, page) {
  if (!page || page.__ndPageLog) return;
  page.__ndPageLog = true;
  const b = bucket(projectId);
  b.attachedAt = new Date().toISOString();
  try {
    page.on('console', (msg) => {
      const type = msg.type();
      if (type !== 'error' && type !== 'warning') return;
      push(b, { kind: 'console', level: type === 'error' ? 'error' : 'warn', text: clip(msg.text()) });
    });
    page.on('pageerror', (err) => push(b, { kind: 'pageerror', level: 'error', text: clip(err?.message || err) }));
    page.on('requestfailed', (req) => push(b, { kind: 'requestfailed', level: 'error', text: clip(`${req.method()} ${req.url()} — ${req.failure()?.errorText || '?'}`) }));
    page.on('response', (res) => { const st = res.status(); if (st >= 400) push(b, { kind: 'response', level: st >= 500 ? 'error' : 'warn', text: clip(`${st} ${res.url()}`) }); });
  } catch { /* 页已经没了 */ }
}

/** 网络闸拒绝这类不经 page 事件的错，工具层可以手动记一笔 */
export function notePageError(projectId, text) { push(bucket(projectId), { kind: 'guard', level: 'error', text: clip(text) }); }

export function readPageLog(projectId, { limit = 100, level = null } = {}) {
  const b = logs.get(projectId);
  if (!b) return { attached: false, items: [], lastError: null };
  const items = (level ? b.items.filter((i) => i.level === level) : b.items).slice(-limit);
  return { attached: true, attachedAt: b.attachedAt, total: b.items.length, items, lastError: b.lastError };
}
export function _resetPageLogs() { logs.clear(); }
