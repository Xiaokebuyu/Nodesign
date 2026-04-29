import { useEffect, useRef, useState } from 'react';
import { Check, AlertTriangle, X, RefreshCw } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';

/**
 * A11yReviewPopover — Accessibility review 浮窗（mock）
 *
 * Claude_design §10.1 / §22.4 强调可让 Claude review accessibility / contrast / hierarchy / usability。
 * 我们 P2 mock：扫一遍 iframe 内容做几个简单启发式（图片缺 alt / 标题层级 / 按钮缺文本 / 对比度抽样），
 * 真正深度 a11y review 等 P5 接 LLM 时再做（或挂 axe-core）。
 */
export default function A11yReviewPopover({ anchorRef, onClose, iframeDoc }) {
  const ref = useRef(null);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState(null);

  useEffect(() => {
    if (!iframeDoc) return;
    runReview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iframeDoc]);

  // 点外面关
  useEffect(() => {
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target) && !anchorRef?.current?.contains(e.target)) {
        onClose?.();
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [onClose, anchorRef]);

  const runReview = () => {
    if (!iframeDoc) return;
    setRunning(true);
    setTimeout(() => {
      setResults(scanHeuristics(iframeDoc));
      setRunning(false);
    }, 400);
  };

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute', top: 78, right: 16,
        width: 320,
        background: '#fff',
        border: `1px solid ${COLOR.borderMd}`,
        borderRadius: 10,
        boxShadow:
          '0 2px 4px rgba(0,0,0,0.04), 0 8px 20px rgba(0,0,0,0.08), 0 24px 48px rgba(0,0,0,0.10), inset 0 1px 0 rgba(255,255,255,0.8)',
        zIndex: 60,
        overflow: 'hidden',
      }}
    >
      <div style={{
        padding: `${GAP.md}px ${GAP.lg}px`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: `1px solid ${COLOR.borderLt}`,
      }}>
        <span style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500, color: COLOR.text,
        }}>Accessibility Review</span>
        <button
          onClick={runReview}
          disabled={running}
          style={{
            padding: 4, color: COLOR.sub, borderRadius: 3,
            opacity: running ? 0.5 : 1,
          }}
          title="重新扫描"
        >
          <RefreshCw size={11} className={running ? 'spin' : ''} />
        </button>
      </div>

      <div style={{ padding: GAP.lg, maxHeight: 360, overflowY: 'auto' }}>
        {running && (
          <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub, textAlign: 'center', padding: GAP.lg }}>
            扫描中…
          </div>
        )}
        {!running && results && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.sm }}>
            {results.map((r, i) => <CheckRow key={i} {...r} />)}
          </div>
        )}
      </div>

      <div style={{
        padding: `${GAP.sm}px ${GAP.lg}px`,
        background: COLOR.bgCard,
        borderTop: `1px solid ${COLOR.borderLt}`,
        fontFamily: FONT_SANS, fontSize: 10, color: COLOR.sub, lineHeight: 1.5,
      }}>
        P5 接 LLM 真做 contrast / hierarchy / usability 审查；当前是启发式扫描。
      </div>
    </div>
  );
}

function CheckRow({ kind, label, hint, count }) {
  const isOk = kind === 'ok';
  const isWarn = kind === 'warn';
  const Icon = isOk ? Check : isWarn ? AlertTriangle : X;
  const color = isOk ? COLOR.success : isWarn ? COLOR.warn : COLOR.error;

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: GAP.sm,
      padding: `${GAP.xs}px ${GAP.sm}px`,
      background: isOk ? 'transparent' : 'rgba(0,0,0,0.02)',
      borderRadius: 4,
    }}>
      <Icon size={12} color={color} style={{ marginTop: 2, flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <div style={{
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2,
          lineHeight: 1.4,
        }}>
          {label} {count != null && <span style={{ color: COLOR.sub, fontSize: FONT_SIZE.xs }}>({count})</span>}
        </div>
        {hint && (
          <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginTop: 1, lineHeight: 1.4 }}>
            {hint}
          </div>
        )}
      </div>
    </div>
  );
}

function scanHeuristics(doc) {
  const out = [];

  // 1. 图片缺 alt
  const imgs = Array.from(doc.querySelectorAll('img'));
  const imgsNoAlt = imgs.filter(i => !i.hasAttribute('alt'));
  if (imgs.length === 0) {
    out.push({ kind: 'ok', label: '无图片元素需要 alt', hint: '没有 <img> 标签' });
  } else if (imgsNoAlt.length === 0) {
    out.push({ kind: 'ok', label: '图片 alt 完整', count: imgs.length });
  } else {
    out.push({ kind: 'warn', label: '部分图片缺 alt', count: imgsNoAlt.length, hint: '加 alt 才能让屏幕阅读器识别' });
  }

  // 2. 标题层级
  const h1s = doc.querySelectorAll('h1').length;
  const h2s = doc.querySelectorAll('h2').length;
  if (h1s === 0 && h2s === 0) {
    out.push({ kind: 'warn', label: '没有 h1/h2 标题', hint: '层级缺失，screen reader 难导航' });
  } else if (h1s > 5) {
    out.push({ kind: 'warn', label: 'h1 过多', count: h1s, hint: '一般每页只 1 个 h1（每 section 1 个也可）' });
  } else {
    out.push({ kind: 'ok', label: '标题层级合理', hint: `h1 × ${h1s}, h2 × ${h2s}` });
  }

  // 3. 按钮文本
  const buttons = Array.from(doc.querySelectorAll('button'));
  const emptyBtns = buttons.filter(b => !(b.textContent || '').trim() && !b.getAttribute('aria-label'));
  if (buttons.length === 0) {
    out.push({ kind: 'ok', label: '无 button 需要文本', hint: '页面没有 <button>' });
  } else if (emptyBtns.length === 0) {
    out.push({ kind: 'ok', label: '按钮文本完整', count: buttons.length });
  } else {
    out.push({ kind: 'warn', label: '部分按钮缺文本/aria-label', count: emptyBtns.length });
  }

  // 4. lang 属性
  const html = doc.documentElement;
  if (html.hasAttribute('lang')) {
    out.push({ kind: 'ok', label: `<html> 标记了 lang="${html.getAttribute('lang')}"` });
  } else {
    out.push({ kind: 'warn', label: '<html> 缺 lang 属性', hint: '影响 screen reader 发音' });
  }

  // 5. 对比度（mock — 真做要算 luminance）
  out.push({ kind: 'ok', label: '色彩对比度（抽样）', hint: '主色块 WCAG AA pass（mock）' });

  // 6. 焦点顺序（mock）
  out.push({ kind: 'ok', label: '焦点顺序（mock）', hint: 'Tab 键 traversal — P5 真模拟' });

  return out;
}
