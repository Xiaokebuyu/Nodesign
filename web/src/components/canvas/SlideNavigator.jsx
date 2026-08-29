import { useEffect, useState, useRef } from 'react';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO } from '../../lib/theme.js';

const LAYOUT_LABEL = {
  cover: 'Cover',
  'title-content': 'Title',
  'two-column': '2-col',
  chart: 'Chart',
  quote: 'Quote',
  custom: 'Custom',
};

/**
 * SlideNavigator — Canvas 顶部的页码缩略图条
 *
 * 扫描 iframe.contentDocument.querySelectorAll('section[data-page]')，
 * 渲染水平滚动 tab 条；当前可视页通过 IntersectionObserver 高亮；点击 scrollIntoView。
 *
 * 没有 section[data-page] 时不显示（避免占空间）。
 */
export default function SlideNavigator({ iframeDoc }) {
  const [pages, setPages] = useState([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const stripRef = useRef(null);

  // 扫描页结构 — 监听 DOM 变化（Code 模式编辑后重新扫）
  useEffect(() => {
    if (!iframeDoc) { setPages([]); return; }

    const scan = () => {
      const sections = Array.from(iframeDoc.querySelectorAll('section[data-page]'));
      const found = sections.map(s => ({
        index: parseInt(s.getAttribute('data-page'), 10),
        layout: s.getAttribute('data-layout') || 'custom',
        title: extractTitle(s),
        el: s,
      })).filter(p => !Number.isNaN(p.index)).sort((a, b) => a.index - b.index);
      setPages(found);
    };
    scan();

    // MutationObserver 监听 body 变化（用户改 HTML 后页结构可能变）
    const observer = new MutationObserver(() => {
      // 防抖：可选，简单实现先不加
      scan();
    });
    if (iframeDoc.body) {
      observer.observe(iframeDoc.body, { childList: true, subtree: false });
    }
    return () => observer.disconnect();
  }, [iframeDoc]);

  // 读 deck-mode（wrap 上的 data-deck-mode attr，未标 = stack 兜底）
  // mode 决定切页机制 + 当前页跟踪机制：
  //   stack/carousel: IntersectionObserver 跟踪滚动位置（IO 在视口内重叠最多的页 = active）
  //   ppt: IO 不可用（section display:none），改读 .active class；切页时给 iframe 内 nav 脚本 postMessage 'canvas-go-page'
  //   custom: 调 iframeWin.__nd_deck.navigateTo(idx) + 读 .getCurrentPage()
  const deckMode = (() => {
    if (!iframeDoc) return 'stack';
    const wrap = iframeDoc.querySelector('.__nd-deck-wrap');
    return (wrap && wrap.getAttribute('data-deck-mode')) || 'stack';
  })();

  // 当前页跟踪：stack/carousel 用 IO；ppt/custom 监听 canvas-page-change postMessage
  useEffect(() => {
    if (!iframeDoc || pages.length === 0) return;
    const win = iframeDoc.defaultView;
    if (!win) return;

    if (deckMode === 'ppt' || deckMode === 'custom') {
      // canvas.template.html 的 nav 脚本 + custom mode 的 agent 实现都会在切页时
      // postMessage canvas-page-change 到 parent。SlideNavigator 直接订阅这个事件
      // 拿真当前页（IO 对 ppt 失效因为所有 section display:none）。
      const onMsg = (ev) => {
        const data = ev?.data;
        if (data?.type === 'canvas-page-change' && Number.isFinite(data.page)) {
          setActiveIndex(data.page);
        }
      };
      window.addEventListener('message', onMsg);
      return () => window.removeEventListener('message', onMsg);
    }

    if (!win.IntersectionObserver) return;
    const visibility = new Map();
    const observer = new win.IntersectionObserver((entries) => {
      entries.forEach(e => {
        const idx = parseInt(e.target.getAttribute('data-page'), 10);
        visibility.set(idx, e.intersectionRatio);
      });
      let bestIdx = activeIndex;
      let bestRatio = 0;
      visibility.forEach((ratio, idx) => {
        if (ratio > bestRatio) { bestRatio = ratio; bestIdx = idx; }
      });
      if (bestRatio > 0) setActiveIndex(bestIdx);
    }, { threshold: [0, 0.25, 0.5, 0.75, 1] });

    pages.forEach(p => observer.observe(p.el));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iframeDoc, pages.length, deckMode]);

  // 当前页变化时把 thumbnail 滚到可见区
  useEffect(() => {
    if (!stripRef.current) return;
    const btn = stripRef.current.querySelector(`[data-thumb-idx="${activeIndex}"]`);
    if (btn) btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [activeIndex]);

  if (pages.length <= 1) return null;

  // 切页按 deck-mode 分流。canvas.template.html 的 nav 脚本已订阅 'canvas-go-page'
  // postMessage（stack 滚到 + ppt toggle active + carousel scrollIntoView inline）；
  // custom mode 调 window.__nd_deck.navigateTo。
  const handleClick = (page) => {
    if (!iframeDoc) return;
    const win = iframeDoc.defaultView;
    if (deckMode === 'custom') {
      const api = win?.__nd_deck;
      if (api && typeof api.navigateTo === 'function') {
        try { api.navigateTo(page.index); } catch { /* fall through to scroll fallback */ }
        return;
      }
      // custom 但没挂 API → 兜底 scrollIntoView（最差体验降级）
    }
    if (deckMode === 'ppt' || deckMode === 'carousel') {
      // 走 iframe 内 nav 脚本的 'canvas-go-page' 协议：脚本会按 mode 自处理
      // (ppt classList.toggle / carousel scrollIntoView inline)
      try {
        win?.postMessage({ type: 'canvas-go-page', page: page.index }, '*');
        return;
      } catch { /* fallback */ }
    }
    // stack 默认：直接 scrollIntoView
    page.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div
      ref={stripRef}
      style={{
        flexShrink: 0,
        height: 44,
        borderBottom: `1px solid ${COLOR.border}`,
        background: '#fafafa',
        padding: `0 ${GAP.lg}px`,
        display: 'flex',
        alignItems: 'center',
        gap: GAP.xs,
        overflowX: 'auto',
        overflowY: 'hidden',
      }}
    >
      <span style={{
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
        textTransform: 'uppercase', letterSpacing: '0.06em',
        flexShrink: 0, marginRight: GAP.sm,
      }}>
        {pages.length} 页
      </span>

      {pages.map(p => {
        const active = p.index === activeIndex;
        return (
          <button
            key={p.index}
            data-thumb-idx={p.index}
            onClick={() => handleClick(p)}
            style={{
              flexShrink: 0,
              minWidth: 88, maxWidth: 168,
              padding: `${GAP.xs}px ${GAP.md}px`,
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
              color: active ? COLOR.text : COLOR.text4,
              background: active ? COLOR.bgWhite : 'rgba(43,33,23,0.03)',
              border: `1px solid ${active ? COLOR.borderMd : 'transparent'}`,
              borderRadius: RADIUS.md,
              boxShadow: active ? '0 1px 3px rgba(93,74,44,0.066)' : 'none',
              textAlign: 'left',
              cursor: 'pointer',
              transition: 'all 0.15s',
              display: 'flex', flexDirection: 'column', gap: 1,
            }}
            title={p.title || `第 ${p.index} 页`}
          >
            <span style={{ fontWeight: 500, lineHeight: 1.2 }}>
              {String(p.index).padStart(2, '0')} · {LAYOUT_LABEL[p.layout] || p.layout}
            </span>
            {p.title && (
              <span style={{
                fontSize: FONT_SIZE.xxs, color: COLOR.sub,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                lineHeight: 1.2,
              }}>{p.title}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function extractTitle(section) {
  const candidates = ['h1', 'h2', '.eyebrow', 'h3'];
  for (const sel of candidates) {
    const el = section.querySelector(sel);
    if (el) {
      const t = (el.textContent || '').trim();
      if (t) return t.slice(0, 22);
    }
  }
  return '';
}
