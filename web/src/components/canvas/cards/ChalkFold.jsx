/**
 * ChalkFold —— 板书过长时把**中段**折起来（2026-09-09，站主：「板书单向延伸过长将中间部分收起」的机制要重启）
 *
 * ## 来龙去脉
 *   08-29 刀 B 做过 FoldBox（折底部 + 展开角标），08-30 刀 E 被站主撤掉（「折叠是逃生舱不是解法」，
 *   改成工具层拒收）。09-05 意图层改口径：**不再拒收，内容照写、卡高封顶、超出的折在卡里** ——
 *   服务端把 layout.h 封在 CARD_MAX_H、工具返回里如实报 folded，可前端那半一直没做：板书按真实高度
 *   渲染，useMeasuredSize 量完把真高写回 layout，封顶当场被冲掉。09-09 量生产板：629 条板书里
 *   190 条超过 384px，最高 2471px。这个文件就是缺的那半。
 *
 * ## 为什么折中段而不是折底
 *   板书的头是它要说的事，尾常是结论或 nd:controls 选项板 —— 两头都不能藏。折掉的只能是中间。
 *
 * ## 纪律
 *   - 折叠必须赶在 paint 之前（useLayoutEffect），否则第一拍以原高画出来、量高的先回写一次真高
 *     （0d6e0b14 的教训）。
 *   - 展开是临时的、不进占位：展开期间父层把 onMeasured 传 null（见 BoardObject），高度不回写。
 *   - 收起要有入口，展开也要有出口（feedback：入口必须同时是出口）：折着时中缝是「展开」，展开后
 *     底下留一条「收起」。
 *   - 尾段是同一份内容再画一遍、往上平移露出末尾 —— 不拆 markdown（拆会切坏围栏/表格/选项板）。
 *   - 父层板书 pointerEvents:none（闲置板书对手势是空地），中缝按钮自己开 auto，跟 MdInk 的选项按钮同一做法。
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { GAP, FONT_SIZE, FONT_SANS } from '../../../lib/theme.js';
import { PAPER } from '../../../lib/paper.js';
import { t } from '../../../lib/i18n.js';

/** 中缝高度（一行说明 + 上下呼吸） */
const SEAM_H = 28;

/**
 * @param {object} p
 * @param {number} p.maxH        折起后内容区总高（含中缝）
 * @param {number} p.lineH       估折掉多少行用
 * @param {(open: boolean) => void} [p.onOpenChange]  展开/收起时告诉父层（父层据此停掉高度回写）
 * @param {string} [p.contentKey] 正文变了要重量（板书流式写入时高度一直在长）
 * @param {() => import('react').ReactNode} p.render  正文的渲染函数（折着时会被调两次：头段 + 尾段）
 */
export default function ChalkFold({ maxH, lineH = 26, onOpenChange, contentKey, render }) {
  const innerRef = useRef(null);
  const [fullH, setFullH] = useState(0);
  const [open, setOpen] = useState(false);

  // paint 前量正文自然高度：inner 自己从不被裁（裁的是它外面那层），offsetHeight 就是真高。
  // 再挂一个 ResizeObserver：markdown 里的图 / 字体晚到会让正文事后长高（真渲实测第一拍只量到一小截），
  // 只靠 contentKey 触发的话那一截之后长出来的永远折不上。
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const measure = () => { const h = Math.round(el.offsetHeight); if (h) setFullH((prev) => (prev === h ? prev : h)); };
    measure();
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(measure); ro.observe(el); }
    return () => ro?.disconnect();
  }, [contentKey]);

  const folded = fullH > maxH && !open;
  const toggle = (e) => {
    e.stopPropagation(); e.preventDefault();
    const next = !open;
    setOpen(next);
    onOpenChange?.(next);
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
    <div data-chalk-fold={folded ? 'folded' : open ? 'open' : 'fits'} style={{ position: 'relative' }}>
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
      {open && fullH > maxH && (
        <div style={{ ...seamStyle, marginTop: GAP.xs }}>
          <button type="button" data-board-action style={btnStyle} onClick={toggle} onPointerDown={(e) => e.stopPropagation()}>
            {t('收起中间')}
          </button>
        </div>
      )}
    </div>
  );
}
