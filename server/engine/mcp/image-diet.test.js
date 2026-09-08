import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { dietImageBlock, withImageDiet, DIET_MAX_EDGE } from './image-diet.js';

async function png(w, h, alpha = false) {
  return sharp({ create: { width: w, height: h, channels: alpha ? 4 : 3, background: alpha ? { r: 200, g: 30, b: 30, alpha: 0.5 } : { r: 200, g: 30, b: 30 } } }).png().toBuffer();
}

describe('图片减重（mcp/image-diet.js）', () => {
  it('大 PNG → 长边 1280 的 JPEG，体积明显变小；透明铺白', async () => {
    const buf = await png(3000, 2000, true);
    const out = await dietImageBlock({ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' });
    expect(out.mimeType).toBe('image/jpeg');
    const m = await sharp(Buffer.from(out.data, 'base64')).metadata();
    expect(m.width).toBe(DIET_MAX_EDGE);
    expect(m.height).toBe(Math.round(DIET_MAX_EDGE * 2 / 3));
    expect(m.hasAlpha).toBe(false);
    expect(out.data.length).toBeLessThan(buf.toString('base64').length / 4);
  });
  it('小 JPEG 原样放行；非图片块不动；出口包装只改 image block', async () => {
    const small = await sharp(await png(400, 300)).jpeg({ quality: 80 }).toBuffer();
    const b = { type: 'image', data: small.toString('base64'), mimeType: 'image/jpeg' };
    expect(await dietImageBlock(b)).toBe(b);
    const big = await png(2600, 1400);
    const tool = withImageDiet({ name: 't', handler: async () => ({ content: [{ type: 'text', text: 'x' }, { type: 'image', data: big.toString('base64'), mimeType: 'image/png' }] }) });
    const r = await tool.handler({}, {});
    expect(r.content[0]).toEqual({ type: 'text', text: 'x' });
    expect(r.content[1].mimeType).toBe('image/jpeg');
    expect((await sharp(Buffer.from(r.content[1].data, 'base64')).metadata()).width).toBe(DIET_MAX_EDGE);
  });
});
