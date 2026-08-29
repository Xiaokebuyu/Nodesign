import { useEffect, useState, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { FONT_MONO, FONT_SIZE, GAP, RADIUS, TERM } from '../../lib/theme.js';

/**
 * PagePager — 预览态的左右翻页（2026-07-28）
 *
 * 预览就是"看成品"，那就该像看幻灯片一样翻。扫 iframe 里的
 * `section[data-page]`，浮一条左右箭头 + 页码在底部中间；点箭头 scrollIntoView，
 * 键盘 ← → 同效。当前页用 IntersectionObserver 跟着滚动位置走。
 *
 * 只有一页（或没有 data-page 结构）时不出现。
 */
export default function PagePager({ iframeDoc, active }) {
  const [pages, setPages] = useState([]);
  const [idx, setIdx] = useState(0);

  // 扫页 + 跟随滚动
  useEffect(() => {
    if (!active || !iframeDoc) { setPages([]); return; }
    let observer = null;
    const scan = () => {
      const found = Array.from(iframeDoc.querySelectorAll('section[data-page]'));
      setPages(found);
      if (observer) observer.disconnect();
      if (!found.length) return;
      try {
        observer = new (iframeDoc.defaultView || window).IntersectionObserver((entries) => {
          const hit = entries.filter(e => e.isIntersecting)
            .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
          if (!hit) return;
          const i = found.indexOf(hit.target);
          if (i >= 0) setIdx(i);
        }, { threshold: [0.35, 0.6] });
        found.forEach(el => observer.observe(el));
      } catch { /* ignore */ }
    };
    scan();
    // Code 模式改完重渲染 / agent 写入后页数会变
    let mo = null;
    try {
      mo = new (iframeDoc.defaultView || window).MutationObserver(() => scan());
      if (iframeDoc.body) mo.observe(iframeDoc.body, { childList: true, subtree: true });
    } catch { /* ignore */ }
    return () => { observer?.disconnect(); mo?.disconnect(); };
  }, [iframeDoc, active]);

  const go = useCallback((next) => {
    setIdx((cur) => {
      const target = Math.max(0, Math.min(pages.length - 1, cur + next));
      const el = pages[target];
      if (el) {
        try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch { /* ignore */ }
      }
      return target;
    });
  }, [pages]);

  // 键盘左右翻页（焦点在窗口或 iframe 里都能用）
  useEffect(() => {
    if (!active || pages.length < 2) return;
    const onKey = (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      go(e.key === 'ArrowRight' ? 1 : -1);
    };
    window.addEventListener('keydown', onKey);
    let doc = null;
    try { doc = iframeDoc; doc?.addEventListener('keydown', onKey); } catch { /* ignore */ }
    return () => {
      window.removeEventListener('keydown', onKey);
      try { doc?.removeEventListener('keydown', onKey); } catch { /* ignore */ }
    };
  }, [active, pages.length, go, iframeDoc]);

  if (!active || pages.length < 2) return null;

  return (
    <div style={{
      position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
      display: 'flex', alignItems: 'center', gap: GAP.xxs,
      background: 'rgba(28,24,18,0.86)', borderRadius: RADIUS.pill, padding: GAP.xs,
      boxShadow: '0 6px 22px rgba(93,74,44,0.242)', zIndex: 30,
      backdropFilter: 'blur(6px)',
    }}>
      <PagerBtn onClick={() => go(-1)} disabled={idx === 0} icon={ChevronLeft} title="上一页（←）" />
      <span style={{
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, color: TERM.ink,
        padding: `0 ${GAP.md}px`, minWidth: 52, textAlign: 'center', userSelect: 'none',
      }}>{idx + 1} / {pages.length}</span>
      <PagerBtn onClick={() => go(1)} disabled={idx === pages.length - 1} icon={ChevronRight} title="下一页（→）" />
    </div>
  );
}

function PagerBtn({ onClick, disabled, icon: Icon, title }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 26, height: 26, borderRadius: RADIUS.round,
        border: 'none', background: 'transparent',
        color: disabled ? 'rgba(232,226,210,0.3)' : TERM.ink,
        cursor: disabled ? 'default' : 'pointer',
        transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = 'rgba(255,254,246,0.12)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    ><Icon size={15} /></button>
  );
}
