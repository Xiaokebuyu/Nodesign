/**
 * 文件夹落点认暂存架（2026-08-30）：空 mkdir 出的文件夹没有 file_changed，
 * 服务端入座器看不见 —— 前端落位是它唯一的口，必须也进架而不是在桌面左上排行。
 */
import { describe, it, expect } from 'vitest';
import { newStackedZoneRect, FOLDER_CARD, MARGIN_X } from './board-geometry.js';

describe('newStackedZoneRect + shelf', () => {
  it('⭐ 有架 → 落在架位上；无架 → 老行为', () => {
    const shelf = { x: -384, y: 0 };
    const r = newStackedZoneRect({}, shelf, { 'ref.jpg': { x: -384, y: 0, w: 200, h: 176 } });
    // 2026-09-01 架改成一摞：文件夹卡也叠在架位上，不再避让带内已有的卡。
    // 原来这儿钉的是「码在已有那件下面」（y = 176 + 24），那是竖列时代的契约。
    expect({ x: r.x, y: r.y }).toEqual({ x: -384, y: 0 });
    expect(r.w).toBe(FOLDER_CARD.w);
    const legacy = newStackedZoneRect({});
    expect(legacy.x).toBe(MARGIN_X);   // 老行为原样：会压纸的那套只在没架时兜底
  });
});
