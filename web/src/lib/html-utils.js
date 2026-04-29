/**
 * HTML / DOM 操作工具
 *
 * 用途：
 *   - inline comment / direct edit / future CAD 拖动 都需要"锚定一个元素"
 *   - 锚点要够稳，能跨 HTML patch 找回（不是只存坐标）
 *
 * 锚点三层（按可靠性从高到低，找回时按顺序尝试）：
 *   1. data-node-id（agent 生成时埋的稳定 id；最可靠）
 *   2. DOM path（tag + nth-of-type 链；HTML 结构没变就稳）
 *   3. textHint（前 50 字 + bbox；前两层都失效时 fuzzy 回找）
 */

/** 把 DOM 元素序列化成可存储的锚点对象 */
export function serializeAnchor(el) {
  if (!el || el.nodeType !== 1) return null;
  const dataId = el.getAttribute?.('data-node-id') || null;
  const path = computeDomPath(el);
  const textHint = (el.textContent || '').trim().slice(0, 50);
  const rect = el.getBoundingClientRect?.() || { x: 0, y: 0, width: 0, height: 0 };
  return {
    dataId,
    path,
    textHint,
    bbox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
  };
}

/** 计算 DOM path：tag:nth-of-type(N) > tag > ... */
function computeDomPath(el, root = el.ownerDocument?.body) {
  const segments = [];
  let cur = el;
  while (cur && cur !== root && cur.nodeType === 1) {
    const tag = cur.tagName.toLowerCase();
    const parent = cur.parentNode;
    if (!parent || parent.nodeType !== 1) break;
    const sameType = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
    const idx = sameType.indexOf(cur) + 1;
    segments.unshift(sameType.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
    cur = parent;
  }
  return segments.join(' > ');
}

/** 用锚点找回元素（按 dataId → path → textHint 顺序）*/
export function findElementByAnchor(anchor, root) {
  if (!anchor || !root) return null;
  if (anchor.dataId) {
    try {
      const byId = root.querySelector(`[data-node-id="${CSS.escape(anchor.dataId)}"]`);
      if (byId) return byId;
    } catch { /* fall through */ }
  }
  if (anchor.path) {
    try {
      const byPath = root.querySelector(anchor.path);
      if (byPath) return byPath;
    } catch { /* invalid selector, fall through */ }
  }
  if (anchor.textHint) {
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let n = walker.nextNode();
    while (n) {
      if ((n.textContent || '').trim().startsWith(anchor.textHint)) return n;
      n = walker.nextNode();
    }
  }
  return null;
}

/** 给 element 加个 data-node-id（如果没有），返回 id。用于让锚点稳定。*/
export function ensureNodeId(el) {
  if (!el || el.nodeType !== 1) return null;
  let id = el.getAttribute('data-node-id');
  if (!id) {
    id = `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    el.setAttribute('data-node-id', id);
  }
  return id;
}
