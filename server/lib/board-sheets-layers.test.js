/**
 * 跨层幻影占位（2026-08-30 刀①，proj_mtfpehm3 案的回归钉）。
 *
 * 病：文件夹层里的文件卡存的是层内坐标，数值恰好落在根层纸的范围里；
 * sheetMembers / membersInRect 不分层直接扫全部 objects，zoneRects 又把子文件夹卡
 * 当根层矩形 —— 前端根本不渲染的东西在服务端把纸「占满」，真会话首拍连吃 4 发
 * 假容量拒收（「main 版位剩 0 行」里 5 件占位者 4 件是幻影）。
 *
 * 判据先验：每条都先摆一个**必须被拒/必须放行**的对照。
 */
import { describe, it, expect } from 'vitest';
import { sheetMembers, membersInRect, nextSpotInSlot } from './board-sheets.js';
import { zoneRects } from './board-kind-sizes.js';
import { obstaclesIn } from './board-obstacles.js';

/** 复刻真案的板：根层一张纸 + 文件夹层里坐标撞进纸面的文件卡 + 子文件夹卡 */
const board = {
  sheets: { ch1: { x: 24, y: 48, w: 2048, h: 973, at: '2026-08-30T11:11:07Z' } },
  zones: {
    世界书: { x: -485, y: -4 },                    // 根层文件夹卡（在纸外）
    记忆: { x: 618, y: 266 },                      // 根层文件夹卡（真在纸上！）
    '世界书/常驻': { x: 922, y: 10 },              // 子文件夹卡：住在 世界书 层
  },
  objects: {
    // 文件夹层里的文件卡 —— 层内坐标，数值撞进根层纸面
    '世界书/常驻/晴可-简述.md': { x: 560, y: 500, w: 208, h: 128 },
    '用户内容/1.png': { x: 48, y: 100, w: 320, h: 240 },
    // 真正的根层板书
    'notes/板书/20260830-第一拍.md': { x: 48, y: 210, w: 648, h: 300 },
  },
};
// 用户内容 也是 zone（否则 1.png 按路径推层会落回根层）
board.zones['用户内容'] = { x: -114, y: -92 };

describe('⛔ 纸面账目只数根层', () => {
  it('sheetMembers：文件夹层的文件卡和子文件夹卡都不算成员；根层板书和根层文件夹卡算', () => {
    const ids = sheetMembers(board, 'ch1').map((m) => m.id);
    expect(ids).toContain('notes/板书/20260830-第一拍.md');
    expect(ids).toContain('记忆');                          // 真占着纸面
    expect(ids).not.toContain('世界书/常驻/晴可-简述.md');   // 幻影
    expect(ids).not.toContain('用户内容/1.png');             // 幻影
    expect(ids).not.toContain('世界书/常驻');                // 子文件夹卡住在父层
  });

  it('membersInRect（版位容量）同一条规矩 —— 真案里「剩 0 行」就是它数了幻影', () => {
    const mainRect = { x: 48, y: 72, w: 648, h: 880 };
    const ids = membersInRect(board, mainRect).map((m) => m.id);
    expect(ids).toContain('notes/板书/20260830-第一拍.md');
    expect(ids).not.toContain('用户内容/1.png');
    // 幻影清掉后这块版位装得下下一条（真案里这一发被拒了）
    const spot = nextSpotInSlot(board, mainRect, { w: 600, h: 254 });
    expect(spot.full).toBeUndefined();
  });

  it('zoneRects 按层取：根层只有顶层文件夹卡；世界书层里才有 常驻 的卡', () => {
    expect(zoneRects(board).map((z) => z.id).sort()).toEqual(['世界书', '用户内容', '记忆']);
    expect(zoneRects(board, { layer: '世界书' }).map((z) => z.id)).toEqual(['世界书/常驻']);
    expect(zoneRects(board, { layer: null })).toHaveLength(4);
  });

  it('obstaclesIn：子文件夹卡是**父层**的障碍，不再是根层的；文件夹层内落位看得见它了', () => {
    expect(obstaclesIn(board, '').map((o) => o.id)).not.toContain('世界书/常驻');
    expect(obstaclesIn(board, '世界书').map((o) => o.id)).toContain('世界书/常驻');
  });
});
