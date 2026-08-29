/**
 * useMeasuredSize —— 物件真实尺寸回写（2026-08-23 建，08-29 纸范式刀 3 扩到全部卡）
 *
 * `layout.w/h` 是服务端落位时**估**的（文字按字数×行高，file/image 这类卡原来
 * 干脆没有 w/h 字段，read_board 只能报形态表猜值）。真值被三处消费：关系线端点、
 * 压上判定、read_board 的尺寸（agent 判摆放全靠它）。所以渲染完量一下真值，
 * 差超过 6px 就回写 layout —— 写一次就稳了，估值只管"第一次落在哪"。
 * 非文字卡只回写高度（contentWidthOf 找不到 data-text-body 时宽不动）。
 *
 * 量的是元素 offsetHeight：它在相机变换的容器里，offset* 是布局尺寸，不受 transform
 * 影响，单位就是世界像素。旋转/缩放过的墨类不回写（那两个字段让 box 不等于布局尺寸）。
 */
import { useEffect, useRef } from 'react';

/**
 * 正文真实宽度（世界像素）：md/板书的块宽是排版约束（w 决定折行），正文可能只占一半 —— 那一半
 * 空白也吃点击、也挡拖拽（08-23 用户报"误触"），所以量正文最右边、只往小了收。
 * 纯手写字的块是 max-content（BoardObject），offsetWidth 就是真值，直接回写。
 */
function contentWidthOf(el) {
  const inner = el.querySelector('[data-text-body]');
  if (!inner) return null;
  const scale = el.offsetWidth ? el.getBoundingClientRect().width / el.offsetWidth : 1;
  if (!scale) return null;
  const base = inner.getBoundingClientRect().left;
  let right = 0;
  try {
    const range = document.createRange(); range.selectNodeContents(inner);
    for (const rc of range.getClientRects()) if (rc.width > 0) right = Math.max(right, rc.right - base);
  } catch { return null; }
  if (!right) return null;
  return Math.round(right / scale) + 12;   // 加回容器 padding（4/6）：layout.w 是整块宽
}

export function useMeasuredSize(ref, o, onMeasured, deps = []) {
  const last = useRef('');
  useEffect(() => {
    if (!onMeasured || !ref.current) return;
    if (o?.data?.rotation || (o?.data?.scale && o.data.scale !== 1)) return;
    const el = ref.current;
    const measure = () => {
      const h = Math.round(el.offsetHeight);
      if (!h) return;
      const plain = o.type === 'text' && o.data?.format !== 'md';
      const w0 = o.pos?.w || 0;
      const patch = {};
      if (plain) {
        // 块 = max-content，offsetWidth 就是真宽，双向回写
        const w = Math.round(el.offsetWidth);
        const key = `${h}:${w}`;
        if (key === last.current) return;
        last.current = key;
        if (Math.abs(w - w0) > 6) patch.w = w;
      } else {
        const cw = contentWidthOf(el);
        const key = `${h}:${cw}`;
        if (key === last.current) return;
        last.current = key;
        // 宽只往小了收（正文比块窄超过 24px 才收；留 8px 余量）：块宽是排版约束，收到正文宽不改折行。
        // 下限 80：再窄就是竖条，宁可留白也不收
        if (cw && cw >= 80 && w0 - (cw + 8) > 24) patch.w = cw + 8;
      }
      if (Math.abs(h - (o.pos?.h || 0)) > 6) patch.h = h;
      if (Object.keys(patch).length) onMeasured(o.id, patch);
    };
    // 字体/KaTeX/mermaid 异步到位：量两拍
    measure();
    const t = setTimeout(measure, 600);
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(measure); ro.observe(el); }
    return () => { clearTimeout(t); ro?.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o?.id, o?.pos?.w, ...deps]);
}
