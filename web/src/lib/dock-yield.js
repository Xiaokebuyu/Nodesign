/**
 * lib/dock-yield.js —— 「给钉住的聊天卡让位」这条规矩，一份（2026-09-10）。
 *
 * 由来：聊天卡钉在侧边时是**绝对定位的悬浮卡，不推挤画布**，所以任何盖在画布上的
 * 显示面自己不躲就会被压掉一条边。09-09 先给六扇产物窗做了（ArtifactWindow），
 * 09-08 更早给桌面版原生浏览器视图做了（BrowserWindow，它必须躲——原生视图画在
 * 所有 HTML 之上）。剩下的显示面**一个都没躲**：图片详情、markdown 阅读器、
 * 项目区四张卡、演出编排设置页。站主 09-10 点名「图片阅读」，其余是一起查出来的。
 *
 * ⛔ 判据只有这一份。三处各写一遍 `deviceClass === 'desktop' && pinned?.width > 0`
 *    就是下一个漏网之鱼的种子（[[feedback-single-source-of-truth]]）。
 *
 * 两条边界，都是有来由的，别在调用点各自重新决定：
 *   · **只让钉住的**：滑出的卡压一会儿就走，跟着缩会抖。
 *   · **只在桌面档让**：平板档整个画布区已经按 chatDockW 收窄过 section
 *     （ProjectWorkspace），再让一次就是让两次；手机上根本没有这张卡。
 *
 * ⚠️ 桌面版那只原生浏览器视图**不走这里**：它要的是逐帧的真实矩形（还要躲开
 *    悬浮态的卡），所以在 BrowserWindow 里直接量 DOM。同一条规矩两种精度，
 *    不是两份判据——那边躲得更宽，是因为被它压住的东西人根本点不着。
 */
import { useMemo } from 'react';
import { useGlobalStore } from '../stores/globalStore.js';
import { useDeviceClass } from './device-class.js';

/** 显示面与卡之间留的缝（跟 ArtifactWindow 原来那个 +10 同一个数） */
export const DOCK_YIELD_GAP = 10;

/**
 * 此刻该往哪边让、让多少。
 * @returns {{side: 'left'|'right', width: number}|null} null = 不用让
 */
export function useDockYield() {
  const pinned = useGlobalStore((s) => s.chatDockPinned);
  const deviceClass = useDeviceClass();
  const ok = deviceClass === 'desktop' && pinned?.width > 0;
  const side = ok ? pinned.side : null;
  const width = ok ? pinned.width : 0;
  // 身份要稳：调用方拿它当 useMemo 的依赖（OrchestrateSettings 的样式表就是），
  // 每次 render 新造一个对象等于把那个 memo 废掉。
  return useMemo(() => (side ? { side, width } : null), [side, width]);
}

/**
 * 让位写成**边距覆盖**：给的是四边写长手的绝对定位面（产物窗那种）。
 * @param {{side: string, width: number}|null} y  useDockYield 的返回
 * @param {number} [base]  原本这一边的值
 */
export function yieldInset(y, base = DOCK_YIELD_GAP) {
  return y ? { [y.side]: y.width + base } : null;
}

/**
 * 让位写成**内边距**：给的是「铺满 + flex 居中」的面（阅读器/详情那种）。
 * 用 padding 而不是 inset，居中的内容才会真的整体挪开，而不是被压扁。
 *
 * ⚠️ **两边永远都写**，不让位时也照写基准值 —— 别只在让位时补一条长手。
 *    React 是按 diff 改样式的：从 {padding, paddingRight} 变回 {padding} 时它会把
 *    paddingRight 设成空串，而空串**连简写铺下来的那份也一起清掉** ——
 *    取消钉住之后那一边的边距会变成 0（测试当场逮到）。同 ArtifactWindow 头上
 *    「四边写长手不写 inset」是一条道理：简写和长手混着用，撤销那一拍必错。
 * @param {{side: string, width: number}|null} y
 * @param {number} base 原本的 padding
 */
export function yieldPadding(y, base) {
  return {
    paddingLeft: (y?.side === 'left' ? y.width + base : base),
    paddingRight: (y?.side === 'right' ? y.width + base : base),
  };
}
