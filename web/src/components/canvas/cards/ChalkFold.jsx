/**
 * ChalkFold —— 板书过长时把**中段**折起来，展开走浮层（2026-09-17 改）
 *
 * ## 来龙去脉
 *   08-29 刀 B 做过 FoldBox（折底部 + 展开角标），08-30 刀 E 被站主撤掉（「折叠是逃生舱不是解法」，
 *   改成工具层拒收）。09-05 意图层改口径：不再拒收、卡高封顶、超出的折在卡里；09-09 补齐前端那半。
 *   09-17 板书树把范式换成**原地重写**（用户标注哪张卡，agent 就改写那张卡，旧正文进 .history/），
 *   折叠的定位跟着翻面：在只增不减的板面上它是逃生舱，在重写模型里**固定高度是板面不抖的地基** ——
 *   没有任何一张卡会改变它占的面积，所以永远不需要为谁腾地方。站主同日定的两条：
 *     1. 尺寸不是 agent 要考虑的事（工具返回里的折起警告整条撤掉，教义也不提）。
 *     2. 展开是临时的：**不多占位置**，盖住下面的内容时带模糊背景，收起消失。
 *
 * ## 于是展开从「把卡撑高」改成「浮层」
 *   旧做法把正文在原地展开、再把真高回写给服务端，为此要两道闸（ref 同步翻、回写不超天花板），
 *   09-09 真渲抓到的竞态就是那么来的：ResizeObserver 的回调赶在被动 effect 清理之前带着旧闭包跑。
 *   浮层之后**卡的高度永远是天花板、永不回写**，那颗雷连同它的闸一起没了。
 *   浮层 portal 到 body：画布那一格钉着 isolation:isolate，留在里面会被别的卡压住，而且会跟着画布缩放。
 *
 * ## 折的还是中段
 *   板书的头是它要说的事，尾常是结论或 nd:controls 选项板，两头都不能藏，折掉的只能是中间。
 *
 * ## 纪律
 *   - 折叠赶在 paint 之前（useLayoutEffect），否则第一拍以原高画出来（0d6e0b14 的教训）。
 *   - 入口同时是出口：中缝是「展开」，浮层里有「收起」，点浮层外、按 Esc 也收。
 *   - 尾段是同一份内容再画一遍、往上平移露出末尾，不拆 markdown（拆会切坏围栏/表格/选项板）。
 *   - 父层板书 pointerEvents:none（闲置板书对手势是空地），中缝按钮自己开 auto。
 */
import { useLayoutEffect, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GAP, FONT_SIZE, FONT_SANS, RADIUS } from '../../../lib/theme.js';
import { PAPER } from '../../../lib/paper.js';
import { PORTAL_Z } from '../../../lib/z-layers.js';
import { t } from '../../../lib/i18n.js';

/** 中缝高度（一行说明 + 上下呼吸） */
const SEAM_H = 28;
/** 浮层：贴着卡的哪一边留多少、最宽多少、最高占视口多少 */
const OVERLAY = { gap: 8, minW: 320, maxW: 560, maxVH: 0.7, pad: 16 };

/** 贴着卡展开：下方放不下就翻到上方；横向夹在视口里 */
export function overlayRect(card, vw, vh, { gap, minW, maxW, maxVH, pad } = OVERLAY) {
  const w = Math.round(Math.min(maxW, Math.max(minW, card.width)));
  const maxH = Math.round(vh * maxVH);
  const below = vh - (card.bottom + gap) - pad;
  const above = card.top - gap - pad;
  const flip = below < Math.min(240, maxH) && above > below;   // 下面放不下、上面更宽敞才翻
  const h = Math.round(Math.min(maxH, Math.max(0, flip ? above : below)));
  const top = flip ? Math.max(pad, card.top - gap - h) : Math.min(vh - pad - h, card.bottom + gap);
  const left = Math.max(pad, Math.min(vw - pad - w, Math.round(card.left + card.width / 2 - w / 2)));
  return { left, top, width: w, maxHeight: h, flip };
}

/**
 * @param {object} p
 * @param {number} p.maxH        折起后内容区总高（含中缝）
 * @param {number} p.lineH       估折掉多少行用
 * @param {string} [p.contentKey] 正文变了要重量（板书流式写入时高度一直在长）
 * @param {() => import('react').ReactNode} p.render  正文的渲染函数（折着时会被调两次：头段 + 尾段）
 */
export default function ChalkFold({ maxH, lineH = 26, contentKey, render }) {
  const innerRef = useRef(null);
  const boxRef = useRef(null);
  const [fullH, setFullH] = useState(0);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);

  // paint 前量正文自然高度：inner 自己从不被裁（裁的是它外面那层），offsetHeight 就是真高。
  // 再挂一个 ResizeObserver：markdown 里的图 / 字体晚到会让正文事后长高（真渲实测第一拍只量到一小截）。
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const measure = () => { const h = Math.round(el.offsetHeight); if (h) setFullH((prev) => (prev === h ? prev : h)); };
    measure();
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(measure); ro.observe(el); }
    return () => ro?.disconnect();
  }, [contentKey]);

  // 浮层开着时跟着卡走：画布平移缩放、窗口改大小都要重算贴边
  useEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const el = boxRef.current;
      if (!el) return;
      setRect(overlayRect(el.getBoundingClientRect(), window.innerWidth, window.innerHeight));
    };
    place();
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.addEventListener('keydown', onKey);
    const timer = setInterval(place, 250);   // 画布平移没有 scroll 事件，低频兜一下
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('keydown', onKey);
      clearInterval(timer);
    };
  }, [open]);

  const folded = fullH > maxH;
  const toggle = (e) => {
    e.stopPropagation(); e.preventDefault();
    setOpen((v) => !v);
  };

  const headH = Math.floor((maxH - SEAM_H) * 0.55);
  const tailH = maxH - SEAM_H - headH;
  const hiddenLines = Math.max(1, Math.round((fullH - headH - tailH) / lineH));
  // 尾段的起点对齐到行：按整行数往上挪，中缝下面不从半行开始（真渲第一版就是半行起头，读着像撕坏了）
  const tailShift = Math.max(0, Math.round(Math.ceil((fullH - tailH) / lineH) * lineH));

  const seamStyle = {
    height: SEAM_H, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: GAP.sm,
    fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: PAPER.ink2, userSelect: 'none',
    // 中缝画成撕开的纸口：上下各一条浅虚线，中间留字
    backgroundImage: `linear-gradient(90deg, ${PAPER.ink2} 0 6px, transparent 6px 12px)`,
    backgroundSize: '12px 1px', backgroundRepeat: 'repeat-x', backgroundPosition: 'center',
  };
  const btnStyle = {
    pointerEvents: 'auto', cursor: 'pointer', border: 0, background: PAPER.paper, color: PAPER.ink2,
    fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, padding: '2px 10px', borderRadius: 999,
    boxShadow: `0 0 0 1px ${PAPER.ink2}40`,
  };

  return (
    <div ref={boxRef} data-chalk-fold={folded ? (open ? 'open' : 'folded') : 'fits'} style={{ position: 'relative' }}>
      <div style={folded ? { height: headH, overflow: 'hidden' } : undefined}>
        <div ref={innerRef}>{render()}</div>
      </div>
      {folded && (
        <>
          <div style={seamStyle}>
            <button type="button" data-board-action style={btnStyle} onClick={toggle} onPointerDown={(e) => e.stopPropagation()}
              title={t('这条板书很长，中间折起来了；点开看全文')}>
              {t('中间折起约 {n} 行 · 展开', { n: hiddenLines })}
            </button>
          </div>
          <div style={{ height: tailH, overflow: 'hidden' }}>
            <div style={{ transform: `translateY(-${tailShift}px)` }} aria-hidden>{render()}</div>
          </div>
        </>
      )}
      {open && rect && typeof document !== 'undefined' && createPortal(
        /* 浮层：临时展开，不占板面。背景模糊不透明，盖住底下的内容也读得清；收起即消失 */
        <div
          data-chalk-overlay
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
          style={{ position: 'fixed', inset: 0, zIndex: PORTAL_Z.POPOVER }}
        >
          <div
            style={{
              position: 'fixed', left: rect.left, top: rect.top, width: rect.width, maxHeight: rect.maxHeight,
              overflowY: 'auto', padding: `${GAP.md}px ${GAP.md}px ${GAP.sm}px`, borderRadius: RADIUS.md,
              background: `${PAPER.paper}f2`, backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
              boxShadow: `0 0 0 1px ${PAPER.ink2}33, 0 18px 40px ${PAPER.ink2}33`,
            }}
          >
            {render()}
            <div style={{ ...seamStyle, marginTop: GAP.xs, position: 'sticky', bottom: 0 }}>
              <button type="button" data-board-action style={btnStyle} onClick={toggle} onPointerDown={(e) => e.stopPropagation()}>
                {t('收起中间')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
