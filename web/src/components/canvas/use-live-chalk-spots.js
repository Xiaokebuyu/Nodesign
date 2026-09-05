/**
 * use-live-chalk-spots —— 板书直播的落点（2026-08-25 建，08-29 占位契约刀 C
 * 改成认 agent 自己给的位置；从 BoardCanvas 拆出是因为行数棘轮）
 *
 * **优先 agent 说的位置**：位置字段随正文第一拍一起流到（write_on_board 的 schema
 * 把 at/sheet 排在 text 前面就是为了这一刻），所以字能直接流到它真正要去的地方。
 * 在这之前落点写死在"视口里一块空地"，写完淡出、真卡在别处接棒 —— 用户看到的是
 * 字凭空跳一下。
 *
 * agent 没给位置（顺排 / 接楼 / 贴放）就退回那块空地。**位置一旦定下就不再改**：
 * 进行中的卡不追手（相机怎么动它都待在原地），这条 08-25 就定了。
 */
import { useRef } from 'react';
import { sheetSpotToWorld } from '../../lib/board-geometry.js';

const MAX_TRACKED = 12;

export function useLiveChalkSpots({ sheets, layout, camera, scrollRef }) {
  const spotsRef = useRef(new Map());
  return (blockId, spot) => {
    const m = spotsRef.current;
    if (!m.has(blockId)) {
      const real = sheetSpotToWorld(sheets, spot, layout);
      if (real) {
        // placed = 这是 agent 说了关系的位置（贴着谁 / 接谁）：渲染层据此画出
        // "框先立在锚旁边"的样子。宽度按三档词（2026-09-05），没给就按内容。
        m.set(blockId, { ...real, placed: true, w: real.w || null, hMin: null });
      } else {
        const r = scrollRef.current?.getBoundingClientRect();
        if (!r) return null;
        const w = camera.toWorld(r.left + r.width * 0.3, r.top + r.height * 0.24);
        m.set(blockId, { x: Math.round(w.x), y: Math.round(w.y) + (m.size % 3) * 40 });
      }
      // 卡收场后条目顺手清（防 Map 无限长）
      if (m.size > MAX_TRACKED) { const k = m.keys().next().value; m.delete(k); }
    }
    return m.get(blockId);
  };
}
