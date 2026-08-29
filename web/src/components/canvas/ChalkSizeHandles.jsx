/**
 * ChalkSizeHandles —— 板书块的宽高手柄（2026-08-28，用户拍板）
 *
 * ## 为什么不是复用 TransformControls
 *
 * 那个是给**墨类原生物件**（text / scribble）的旋转 + 整体缩放，写 `data.rotation`
 * / `data.scale`。板书要的是另一件事：改**版心宽度**让正文重新折行。缩放会把字
 * 一起放大，那不是"调宽"。而且板书是文件类物件（backing:'file'），压根走不到
 * TransformControls 那条 `o.native` 判据里 —— 所以在此之前用户根本调不了板书。
 *
 * ## 宽是真的，高是下限
 *
 * 前端 BoardObject 给板书 `width: sz.w`，正文按它折行 —— 拖宽立刻看得见。
 * **高度没有 height，由正文撑**。所以高度手柄写的是"至少这么高"（minHeight）：
 * 往下拖到内容高度就停住，绝不把 agent 写的字裁掉或藏进滚动条里 —— 板要能导出，
 * 看不见的字等于丢了字。往上拖是留白，那是排版意图，留得住。
 *
 * ## 盖章
 *
 * 拖完写 `sized: 'user'`。这枚章有两个读者：重排别拿正文估宽盖掉他调过的宽；
 * 写入端拿它当学习票源推断"他喜欢多宽的板书"（server/lib/chalk-size-pref.js）。
 * 章由前端手势盖、服务端白名单收 —— 模型盖不出来。
 *
 * ⚠️ 手柄自己捕获指针并 stopPropagation，且带 `data-transform-handle`
 * （"点空白取消选中"的豁免名单）—— 不拦的话 pointerdown 会穿到画布变成平移。
 */
import { useRef } from 'react';
import { CANVAS, alpha } from '../../lib/theme.js';

/** 最小宽（网格 8 格 = write_on_board schema 的下限，两边一把尺） */
const MIN_W = 8 * 24;
/** 最小高：正文再短也留一行的地方 */
const MIN_H = 24;

/**
 * 正文的**自然**高度（世界单位）—— 高度手柄的下限。
 *
 * ⛔⛔ **必须先把 minHeight 摘掉再量**（2026-08-28 用户实报「拉高之后缩不回去」）。
 * 留白是用 minHeight 实现的，minHeight 一生效，量到的高**就是留白本身**：
 *
 *   拖到 200 → 存 h=200 → minHeight:200 → 下次量还是 200 → 下限=200 → 再也下不去
 *
 * 每拖高一次地板就跟着抬一次，这是个自反馈的棘轮。摘掉再量拿到的才是「字占多高」，
 * 于是往回缩能一路缩到贴着正文为止。量完立刻还原，同步块内完成，不会闪。
 *
 * 抽成独立函数是为了可测：happy-dom 没有真布局引擎，量不出这个 bug，
 * 但一个「高度受 minHeight 影响」的假元素能把棘轮原样复现（见同名测试）。
 */
export function naturalHeightOf(el, camScale = 1) {
  if (!el) return 0;
  const saved = el.style.minHeight;
  el.style.minHeight = '0px';
  const h = el.getBoundingClientRect().height / Math.max(0.05, camScale);
  el.style.minHeight = saved;
  return h;
}

export default function ChalkSizeHandles({ o, sz, camScale = 1, toWorld, onResize }) {
  const gestureRef = useRef(null);
  const k = 1 / Math.max(0.05, camScale);   // 手柄屏幕恒定大小
  const grip = 11 * k;

  /** 正文此刻实际多高（世界单位）—— 高度手柄的下限，拖不到比字还矮 */
  const contentH = () => Math.max(
    MIN_H,
    Math.round(naturalHeightOf(document.querySelector(`[data-board-object="${CSS.escape(String(o.id))}"]`), camScale)),
  );

  const start = (e, axis) => {
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const w = toWorld(e.clientX, e.clientY);
    gestureRef.current = { axis, ox: w.x, oy: w.y, w0: sz.w, h0: sz.h, minH: contentH() };
  };

  const move = (e) => {
    const g = gestureRef.current;
    if (!g) return;
    e.stopPropagation();
    const w = toWorld(e.clientX, e.clientY);
    const patch = {};
    if (g.axis !== 'h') patch.w = Math.max(MIN_W, Math.round(g.w0 + (w.x - g.ox)));
    if (g.axis !== 'w') patch.h = Math.max(g.minH, Math.round(g.h0 + (w.y - g.oy)));
    onResize(patch);
  };

  const end = (e) => {
    if (!gestureRef.current) return;
    e.stopPropagation();
    gestureRef.current = null;
  };

  const handle = (axis, style, cursor, title) => (
    <div
      data-transform-handle
      data-no-pan
      title={title}
      onPointerDown={(e) => start(e, axis)}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      style={{
        position: 'absolute', width: grip, height: grip,
        borderRadius: 2 * k,
        background: CANVAS.paper, border: `${1.5 * k}px solid ${CANVAS.brass}`,
        cursor, touchAction: 'none', pointerEvents: 'auto',
        ...style,
      }}
    />
  );

  return (
    <div style={{
      position: 'absolute', left: o.pos.x, top: o.pos.y, width: sz.w, height: sz.h,
      pointerEvents: 'none', zIndex: (o.pos.z || 1) + 1,
      outline: `${1 * k}px dashed ${alpha(CANVAS.brass, 0.55)}`, outlineOffset: 2 * k,
    }}>
      {/* 右缘：只调宽（正文重新折行） */}
      {handle('w', { right: -grip / 2, top: `calc(50% - ${grip / 2}px)` }, 'ew-resize', '拖着调版心宽度')}
      {/* 下缘：只调高（留白下限，拖不到比正文矮） */}
      {handle('h', { bottom: -grip / 2, left: `calc(50% - ${grip / 2}px)` }, 'ns-resize', '拖着调这一块留多少空')}
      {/* 右下角：两边一起 */}
      {handle('wh', { right: -grip / 2, bottom: -grip / 2 }, 'nwse-resize', '拖着同时调宽高')}
    </div>
  );
}
