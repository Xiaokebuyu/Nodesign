/**
 * DirectEditBridge — iframe 内 DOM 编辑桥接
 *
 * 策略：开发时 iframe 跟父页面同源（vite proxy / 静态资源同 host），所以可以直接
 * 通过 iframe.contentDocument 跨边界操作 DOM 和挂事件。生产部署如果跨 origin，
 * 改成 postMessage + iframe 内置 listener；P1 走 same-origin 简单路径。
 *
 * 提供 3 类能力（按 mode）：
 *   - attachEditMode：双击文本 → contenteditable，blur 后回调改动
 *   - attachSelectMode：点击元素 → 高亮 + 回调（comment 锚定用）
 *   - detachAll：清理一切
 */

import { serializeAnchor } from '../../lib/html-utils.js';

const STATE_KEY = '__nodesignBridgeState';

function getState(iframe) {
  return iframe[STATE_KEY] || (iframe[STATE_KEY] = {});
}

/** 双击文本 → contenteditable */
export function attachEditMode(iframe, { onTextEdit, onSelect } = {}) {
  const doc = safeContentDoc(iframe);
  if (!doc) return;

  detachAll(iframe);

  const state = getState(iframe);

  const handleDblClick = (e) => {
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    // 只让"叶子文本元素"可编辑：h1/h2/h3/p/span/li/div（含 textContent 没有子元素 block）
    if (!isTextLeaf(el)) return;
    e.preventDefault();
    e.stopPropagation();
    el.setAttribute('contenteditable', 'true');
    el.style.outline = '2px solid #2d2418';
    el.style.outlineOffset = '4px';
    el.focus();
    // 选中全部文本，方便覆盖输入
    const range = doc.createRange();
    range.selectNodeContents(el);
    const sel = doc.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const oldText = el.textContent;
    const cleanup = () => {
      el.removeEventListener('blur', handleBlur);
      el.removeEventListener('keydown', handleKey);
      el.removeAttribute('contenteditable');
      el.style.outline = '';
      el.style.outlineOffset = '';
    };
    const handleBlur = () => {
      const newText = el.textContent;
      cleanup();
      if (newText !== oldText) {
        onTextEdit?.({
          anchor: serializeAnchor(el),
          oldText,
          newText,
        });
      }
    };
    const handleKey = (ke) => {
      if (ke.key === 'Escape') {
        el.textContent = oldText; // revert
        el.blur();
      } else if (ke.key === 'Enter' && !ke.shiftKey) {
        ke.preventDefault();
        el.blur(); // 触发 handleBlur 上报
      }
    };
    el.addEventListener('blur', handleBlur);
    el.addEventListener('keydown', handleKey);
  };

  const handleClick = (e) => {
    // 单击但不是从 contenteditable 进来 → 当作 select
    if (e.target.getAttribute?.('contenteditable') === 'true') return;
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    // C3：点空白（body / html）→ 清选中（关 InspectFloatingCard）
    if (el === doc.body || el === doc.documentElement) {
      onSelect?.({ anchor: null });
      return;
    }
    onSelect?.({
      anchor: serializeAnchor(el),
    });
  };

  doc.addEventListener('dblclick', handleDblClick, true);
  doc.addEventListener('click', handleClick, true);

  state.handleDblClick = handleDblClick;
  state.handleClick = handleClick;
  state.mode = 'edit';
}

/** 清理所有 listener，恢复 iframe 的"纯展示"状态 */
export function detachAll(iframe) {
  const doc = safeContentDoc(iframe);
  if (!doc) return;
  const state = getState(iframe);
  if (state.handleDblClick) doc.removeEventListener('dblclick', state.handleDblClick, true);
  if (state.handleClick)    doc.removeEventListener('click',    state.handleClick,    true);
  // 清理任何残留的 contenteditable
  const remains = doc.querySelectorAll('[contenteditable="true"]');
  remains.forEach(el => {
    el.removeAttribute('contenteditable');
    el.style.outline = '';
    el.style.outlineOffset = '';
  });
  state.handleDblClick = null;
  state.handleClick = null;
  state.mode = null;
}

function safeContentDoc(iframe) {
  try {
    return iframe?.contentDocument || iframe?.contentWindow?.document || null;
  } catch {
    // 跨域会抛 SecurityError；P1 走 same-origin 不会
    return null;
  }
}

function isTextLeaf(el) {
  if (!el || el.nodeType !== 1) return false;
  // 不能是结构容器（含 block 子元素）
  const blockChildren = el.querySelector(':scope > div, :scope > section, :scope > article, :scope > main, :scope > header, :scope > footer, :scope > nav, :scope > ul, :scope > ol');
  if (blockChildren) return false;
  return ['H1','H2','H3','H4','H5','H6','P','SPAN','LI','DIV','A','STRONG','EM','SMALL','LABEL','BUTTON'].includes(el.tagName);
}
