/**
 * 服务端身位镜像的 parity 钉子（2026-08-14）。
 *
 * `server/lib/board-kind-sizes.js` 抄了前端 board-kinds 的身位常量给
 * read_board / arrange_on_board 估矩形用。双份表的宿命是漂移 —— 这里逐项对账，
 * 改一边忘另一边直接红（binding-types 那对表同款纪律）。
 */
import { describe, it, expect } from 'vitest';
import {
  DECK_EMBED_W as SRV_DECK_W, ARTIFACT_HEADER_H as SRV_HEADER,
  ARTIFACT_PREVIEW_H as SRV_PREVIEW, KIND_SIZES, estimateSize,
  FOLDER_CARD as SRV_FOLDER,
} from '../../../server/lib/board-kind-sizes.js';
import { ARTIFACT_HEADER_H, ARTIFACT_PREVIEW_H, KINDS, sizeOf } from './board-kinds.js';
import { DECK_EMBED_W, FOLDER_CARD } from './board-geometry.js';

describe('服务端身位镜像 parity', () => {
  it('产物卡三常量逐项一致', () => {
    expect(SRV_DECK_W).toBe(DECK_EMBED_W);
    expect(SRV_HEADER).toBe(ARTIFACT_HEADER_H);
    expect(SRV_PREVIEW).toEqual(ARTIFACT_PREVIEW_H);
  });

  /**
   * 文件夹卡身位（2026-08-29 占位契约刀 A）：zones 存档只有 {x,y}，尺寸全靠这个
   * 常量。服务端拿它当障碍矩形（板书不许压在文件夹上），前端拿它画卡 —— 两边一旦
   * 分叉，agent 算的避让就是错的，而且不报错。
   */
  it('文件夹卡身位两端一致', () => {
    expect(SRV_FOLDER).toEqual(FOLDER_CARD);
  });

  it('KIND_SIZES 每一项与前端形态表相同', () => {
    for (const [k, sz] of Object.entries(KIND_SIZES)) {
      expect(KINDS[k]?.size, `KINDS.${k}.size`).toEqual(sz);
    }
  });

  it('estimateSize 与前端 sizeOf 对齐（抽查三形态）', () => {
    expect(estimateSize('deck:海报/主稿.html')).toEqual(sizeOf({ type: 'deck' }));
    expect(estimateSize('assets/generated/x.webp')).toEqual(sizeOf({ type: 'image' }));
    expect(estimateSize('text:abc', { w: 180, h: 44 })).toEqual({ w: 180, h: 44 });
    // 文本文件卡（08-24 预览体）：两边都按 note 身位
    expect(estimateSize('记忆/style-anchor.md')).toEqual(sizeOf({ type: 'file', name: 'style-anchor.md' }));
    expect(estimateSize('data/config.json')).toEqual(sizeOf({ type: 'file', name: 'config.json' }));
  });
});
