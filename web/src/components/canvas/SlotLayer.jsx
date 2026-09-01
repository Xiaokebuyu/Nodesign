/**
 * SlotLayer —— 把这一摞的版式画出来（2026-09-01 册）
 *
 * ## 这跟 08-29 撤掉的 SheetLayer 不是一回事
 *
 * 那次撤的是**画纸**，站主的判词是「纸只是位置范围的概念，写字人心里的页界，
 * 读的人只看见字」。这次画的是**版位** —— agent 规划出来的那几块地。两者的差别
 * 在于「用户需不需要知道它」：纸的边界他不需要（那是分配纪律），而版式他需要，
 * 因为叠纸之后一摞就是一本册子，册子有固定的版心和分栏，那是他判断「这一摞在
 * 怎么用」的唯一线索。站主原话：「用户需要看见这个版式」，紧接着一句
 * 「这整个堆叠板书我感觉很像是一摞叠放的设计稿」—— 所以画法照设计稿的版心走：
 * 极淡的界线 + 角上一个名字，不抢内容。
 *
 * ## 三条克制
 *
 * 1. **只画当前显示的那一页**的版位。别的页在屏幕上不存在，画它们的地是骗人。
 * 2. **不吃指针**（pointerEvents:none），压在卡片下面。它是一层底稿不是控件。
 * 3. **缩到读不了就整层不画**：跟分级渲染同一条道理，1:20 的时候几十条虚线
 *    只是噪点。判据借 LOD 那个 `renderedW`，别自己再造一个阈值。
 *
 * ## 可改：只拖得动右边和下边
 *
 * 站主要的是「（可改）」。**只做改尺寸不做挪位置** —— 挪一块地会把里面已经写好的
 * 内容甩在外面，那不是用户想要的「调一下版面」，是搬家。而尺寸（尤其高度）正是
 * agent 的 replan 最常动的那个数，也是用户看着觉得不对最想动的那个。
 *
 * ⚠️ 命中区只在**边上那 8px**，块内照旧不吃指针 —— 版位铺满整张纸，块内可点的话
 * 卡片就全选不中了。
 *
 * 改完写回**这一块此刻住的那一层**：这一页覆盖过就写这一页，否则写整摞的版式。
 * 拖的是我看见的那一块，改的就是它 —— 别让用户去想"我这一下改的是页还是册"。
 * 落盘顺手盖 `by:'user'`，agent 下次 replan 改到它时报文会说一句「这块是用户
 * 亲手调的」（别跟用户拔河那条规矩，前提是它知道）。
 */
import { useState, useCallback, useRef } from 'react';
import { P, PAPER } from '../../lib/paper.js';
import { renderedW, LABEL_ONLY_W } from '../../lib/board-lod.js';
import { Assets } from '../../lib/api.js';

/** 版位名画多大 —— 比正文小一档，它是标注不是内容 */
const LABEL = 11;

/** 边上的命中带宽度（屏幕像素）。比 8 再窄就抓不住，再宽会压住块内的卡 */
const EDGE = 8;
/** 一块地最小多大（跟服务端 sanitizeSlot 的下限对齐：48x24） */
const MIN_W = 48; const MIN_H = 24;

export default function SlotLayer({ piles, sheets, stacks, shownOf, scale, projectId, onChanged }) {
  /** 拖动中的临时形状（松手才落盘）：{ key, w, h } */
  const [draft, setDraft] = useState(null);
  const dragRef = useRef(null);

  const onDown = useCallback((e, box, axis) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.stopPropagation(); e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { box, axis, x0: e.clientX, y0: e.clientY, w0: box.w, h0: box.h };
    setDraft({ key: box.key, w: box.w, h: box.h });
  }, []);

  const onMove = useCallback((e) => {
    const d = dragRef.current;
    if (!d) return;
    const z = scale || 1;
    const w = d.axis === 'y' ? d.w0 : Math.max(MIN_W, Math.round(d.w0 + (e.clientX - d.x0) / z));
    const h = d.axis === 'x' ? d.h0 : Math.max(MIN_H, Math.round(d.h0 + (e.clientY - d.y0) / z));
    setDraft({ key: d.box.key, w, h });
  }, [scale]);

  const onUp = useCallback(async () => {
    const d = dragRef.current;
    dragRef.current = null;
    const cur = draft;
    setDraft(null);
    if (!d || !cur || (cur.w === d.w0 && cur.h === d.h0)) return;
    const { box } = d;
    const next = { ...box.slot, w: cur.w, h: cur.h, by: 'user' };
    // 写回这一块此刻住的那一层：这一页覆盖过就写这一页，否则写整摞
    const patch = box.own
      ? { sheets: { [box.sheetId]: { slots: { [box.name]: next } } } }
      : { stacks: { [box.pile]: { slots: { [box.name]: next } } } };
    try { await Assets.patchBoard(projectId, patch); onChanged?.(); } catch { /* 写不进去就算了，下一拍还在 */ }
  }, [draft, projectId, onChanged]);

  if (!piles?.length) return null;
  const boxes = [];
  for (const pile of piles) {
    if (pile.shelf) continue;                       // 架那一摞没有版式
    const id = shownOf(pile.name);
    const sh = id ? sheets?.[id] : null;
    if (!sh) continue;
    const base = stacks?.[pile.name]?.slots || null;
    const live = base ? { ...base, ...(sh.slots || {}) } : (sh.slots || {});
    for (const [name, sl] of Object.entries(live)) {
      boxes.push({
        key: `${id}:${name}`, name, slot: sl, sheetId: id, pile: pile.name,
        // 版位坐标是纸内局部像素，原点在版心左上（服务端 slotRectOf 同一套）
        x: sh.x + 24 + sl.x, y: sh.y + 24 + sl.y, w: sl.w, h: sl.h,
        about: sl.about || null,
        // 这一块是这一页自己改过的，还是整摞共用的 —— 用户要看得出差别
        own: !!sh.slots?.[name],
        artifacts: sl.for === 'artifacts',
      });
    }
  }
  if (!boxes.length) return null;
  return (
    <>
      {boxes.map((b) => {
        // 这一块此刻在屏幕上有多宽：太小就连名字都不画（画了也是一团糊）
        const px = renderedW(b.w, scale);
        if (px < 40) return null;
        const live = draft?.key === b.key ? draft : b;
        return (
          <div
            key={b.key}
            data-slot-guide={b.name}
            style={{
              position: 'absolute', left: b.x, top: b.y, width: live.w, height: live.h,
              border: `1px ${b.own ? 'solid' : 'dashed'} ${P('pencil', b.own ? 0.3 : 0.2)}`,
              borderRadius: 3,
              pointerEvents: 'none',
              zIndex: 0,
              ...(b.artifacts ? { background: P('pencil', 0.03) } : null),
            }}
          >
            {/* 右边和下边各一条 8px 的命中带 —— 只有它们吃指针，块内照旧不吃 */}
            {[['x', { right: -EDGE / 2, top: 0, width: EDGE, height: '100%', cursor: 'ew-resize' }],
              ['y', { bottom: -EDGE / 2, left: 0, height: EDGE, width: '100%', cursor: 'ns-resize' }]].map(([axis, st]) => (
                <div
                  key={axis}
                  data-slot-handle={`${b.name}:${axis}`}
                  onPointerDown={(e) => onDown(e, { ...b, w: live.w, h: live.h }, axis)}
                  onPointerMove={onMove}
                  onPointerUp={onUp}
                  onPointerCancel={onUp}
                  style={{ position: 'absolute', pointerEvents: 'auto', ...st }}
                />
            ))}
            {px >= LABEL_ONLY_W && (
              <div style={{
                position: 'absolute', top: 2, left: 5,
                fontSize: LABEL, lineHeight: `${LABEL + 3}px`,
                color: PAPER.pencil, opacity: 0.55, userSelect: 'none', whiteSpace: 'nowrap',
              }}>
                {b.name}{b.about ? ` · ${b.about}` : ''}{b.artifacts ? ' · 产物' : ''}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
