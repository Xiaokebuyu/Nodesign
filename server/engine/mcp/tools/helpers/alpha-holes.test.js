/**
 * 围住的洞（09-11 牛皮纸袋白标签案）：浅色标签被 rembg 当背景挖掉，预览铺白底看不出来。
 * 这几条钉的是：洞要数得出、外面的背景不能算洞、补回来用原图的颜色、预览上洞看得见。
 */
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { findEnclosedHoles, fillEnclosedHoles, inspectCutout } from './alpha-holes.js';

/** 40×40：外圈 5px 透明背景，中间 30×30 不透明主体，主体正中挖一个 10×10 的洞 */
function bagWithHole({ hole = true } = {}) {
  const w = 40; const h = 40;
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const inBody = x >= 5 && x < 35 && y >= 5 && y < 35;
      const inHole = hole && x >= 15 && x < 25 && y >= 15 && y < 25;
      if (inBody && !inHole) { px[i] = 150; px[i + 1] = 110; px[i + 2] = 60; px[i + 3] = 255; }   // 牛皮纸色
      // 透明处 RGB 留 0：rembg fast 档就是这么交的
    }
  }
  return { px, w, h };
}

describe('findEnclosedHoles', () => {
  it('数出被主体围住的洞，外圈背景不算', () => {
    const { px, w, h } = bagWithHole();
    const r = findEnclosedHoles(px, w, h);
    expect(r.holes).toHaveLength(1);
    expect(r.holes[0].size).toBe(100);
    expect(r.holePx).toBe(100);
    expect(r.foregroundPx).toBe(30 * 30 - 100);
  });

  it('没洞就是空的', () => {
    const { px, w, h } = bagWithHole({ hole: false });
    expect(findEnclosedHoles(px, w, h).holes).toHaveLength(0);
  });

  it('碎点（小于 64px）不报：发丝缝、matting 散点不该吓唬 agent', () => {
    const { px, w, h } = bagWithHole({ hole: false });
    for (const [x, y] of [[10, 10], [11, 10], [20, 20]]) px[(y * w + x) * 4 + 3] = 0;
    expect(findEnclosedHoles(px, w, h).holes).toHaveLength(0);
  });
});

describe('fillEnclosedHoles', () => {
  it('补回不透明，颜色取原图（不补出一块黑）', () => {
    const { px, w, h } = bagWithHole();
    const src = new Uint8Array(w * h * 4).fill(230);   // 原图：标签是浅米色
    const { label } = findEnclosedHoles(px, w, h);
    const out = fillEnclosedHoles(px, w, h, label, src);
    const c = (20 * w + 20) * 4;
    expect(out[c + 3]).toBe(255);
    expect(out[c]).toBe(230);
    expect(out[3]).toBe(0);                             // 左上角背景照旧透明
    expect(px[c + 3]).toBe(0);                          // 不改入参
  });
});

describe('inspectCutout', () => {
  const png = async ({ hole = true } = {}) => {
    const { px, w, h } = bagWithHole({ hole });
    return sharp(Buffer.from(px), { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  };

  it('默认只报不补；预览是不透明的棋盘格底，洞那块露出格子', async () => {
    const r = await inspectCutout(await png());
    expect(r.filled).toBe(false);
    expect(r.holes).toHaveLength(1);
    const { data, info } = await sharp(r.preview).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    const c = (20 * info.width + 20) * 3;
    expect([0xDD, 0x99]).toContain(data[c]);            // 洞里是格子色，不是主体色也不是白
  });

  it('fill:true 补洞并用原图颜色；前景占比把补回的算进去', async () => {
    const source = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 230, g: 225, b: 215 } } }).png().toBuffer();
    const r = await inspectCutout(await png(), { fill: true, source });
    expect(r.filled).toBe(true);
    const { data } = await sharp(r.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const c = (20 * 40 + 20) * 4;
    expect(data[c + 3]).toBe(255);
    expect(data[c]).toBe(230);
    expect(r.foregroundPct).toBeCloseTo(900 / 1600 * 100, 5);
  });
});
