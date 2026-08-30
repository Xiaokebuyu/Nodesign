/**
 * FoldBox —— 卡里长内容的折叠盒（2026-08-29 占位契约刀 B）
 *
 * 卡的高度原来完全由内容决定、没有上限：生产真板上最高一条板书 **2471px**，
 * 312 宽、2471 高，一整章小说写成一根柱子劈开整个版面。而且落位系统按估算高度
 * 把下一条排在它底下之后，渲染回写又把卡撑大去压邻居 —— 82 对文字叠文字就是
 * 这么攒的。
 *
 * 天花板 = CARD_MAX_H（站主定「一张纸的 40%」）。超出的不丢，折在卡里，底部
 * 一枚角标点开。**展开是临时的、不进占位**：展开期间父层把 onMeasured 传 null，
 * 高度不回写 layout —— 用户自己点开的东西临时压住下面，跟他自己拖卡一样合法。
 *
 * 判据要能自愈：markdown 里的 KaTeX/mermaid/字体都是异步到位的，量一拍会把
 * 「还没排完的长内容」当成短内容（useMeasuredSize 同款教训），所以量两拍 +
 * ResizeObserver 跟着变。
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { CARD_MAX_H } from '../../../lib/board-geometry.js';
import { COLOR, FONT_SIZE, GAP, RADIUS, alpha } from '../../../lib/theme.js';
import { PAPER } from '../../../lib/paper.js';

export default function FoldBox({ open = false, onToggle = null, maxH = CARD_MAX_H, children }) {
  const innerRef = useRef(null);
  const [tall, setTall] = useState(false);

  // ⚠️ useLayoutEffect 不是 useEffect：折叠必须发生在 paint 之前。用 useEffect 的话
  // 存量的高卡（老板上有 2471px 的板书）第一拍会以原高渲染出来，而 useMeasuredSize
  // 同在 effect 阶段量高 —— 它会把折叠前的 2471 先回写一次，再收敛到 384，白落一次盘。
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return undefined;
    // 4px 容差：正好卡在天花板上的内容别为了几个像素挂一枚角标
    const measure = () => setTall(el.scrollHeight > maxH + 4);
    measure();
    const t = setTimeout(measure, 600);        // KaTeX/mermaid/字体异步到位
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(measure); ro.observe(el); }
    return () => { clearTimeout(t); ro?.disconnect(); };
  }, [maxH, children]);

  const folded = tall && !open;
  return (
    <div style={{ position: 'relative' }}>
      <div
        ref={innerRef}
        data-fold-body
        style={folded ? {
          maxHeight: maxH,
          overflow: 'hidden',
          // 底部渐隐：明确告诉读者"下面还有"，不是内容到此为止
          maskImage: 'linear-gradient(180deg, #000 82%, transparent)',
          WebkitMaskImage: 'linear-gradient(180deg, #000 82%, transparent)',
        } : undefined}
      >
        {children}
      </div>
      {tall && (
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onToggle?.(); }}
          style={{
            position: 'absolute', left: '50%', transform: 'translateX(-50%)',
            bottom: open ? -10 : -6,
            // 父层给文字关了指针（闲置板书是"空地"），角标要自己开回来
            pointerEvents: 'auto', cursor: 'pointer',
            border: `1px solid ${alpha(PAPER.ink, 0.14)}`,
            background: PAPER.paper, color: COLOR.text2,
            borderRadius: RADIUS.pill,
            fontSize: FONT_SIZE.xs, lineHeight: 1.4,
            padding: `1px ${GAP.sm}px`,
          }}
        >
          {open ? '收起 ⌃' : '展开 ⌄'}
        </button>
      )}
    </div>
  );
}
