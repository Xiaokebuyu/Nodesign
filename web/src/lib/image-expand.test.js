import { describe, it, expect } from 'vitest';
import { imageExpandPatch, EXPANDED_IMAGE_W, IMAGE_NAME_BAR_H } from './image-expand.js';
import { sizeOf, KINDS } from './board-kinds.js';

describe('照片展开模式', () => {
  it('展开：按原图比例定高、盖 sized:user；sizeOf 跟着读落盘尺寸（脚印跟着变）', () => {
    const o = { id: 'a.png', type: 'image', pos: { x: 0, y: 0 } };
    const patch = imageExpandPatch(o, () => ({ nw: 1600, nh: 900 }));
    expect(patch).toEqual({ w: EXPANDED_IMAGE_W, h: Math.round(EXPANDED_IMAGE_W * 900 / 1600) + IMAGE_NAME_BAR_H, sized: 'user' });
    expect(sizeOf({ ...o, pos: { ...o.pos, ...patch } })).toEqual({ w: patch.w, h: patch.h });
  });
  it('收回：回形态表默认并清章；没盖章的落盘尺寸不算展开（存量 expanded:true 那个坑）', () => {
    const o = { id: 'a.png', type: 'image', pos: { x: 0, y: 0, w: 480, h: 296, sized: 'user' } };
    expect(imageExpandPatch(o)).toEqual({ ...KINDS.image.size, sized: null });
    expect(sizeOf({ id: 'b.png', type: 'image', pos: { x: 0, y: 0, w: 640, h: 388, expanded: true } })).toEqual(KINDS.image.size);
  });
});
