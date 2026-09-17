import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { describeImageFacts } from './image-facts.js';

const png = (width, height, alpha = 1) => sharp({ create: { width, height, channels: 4, background: { r: 200, g: 10, b: 10, alpha } } }).png().toBuffer();

describe('describeImageFacts（09-14：返回里写量出来的尺寸，不回显请求）', () => {
  it('请求 21:9 拿到 16:9：报真尺寸并警告', async () => {
    const s = await describeImageFacts(await png(1672, 941), '21:9');
    expect(s).toContain('1672×941');
    expect(s).toContain('请求的 21:9');
  });
  it('比例对得上：不警告；不透明的 RGBA 不报透明', async () => {
    const s = await describeImageFacts(await png(1536, 1024), '3:2');
    expect(s).toBe('1536×1024 ≈1.50:1');
  });
  it('真有透明像素才说', async () => {
    expect(await describeImageFacts(await png(64, 64, 0), '1:1')).toContain('含透明像素');
  });
  it('不是图：null，不抛', async () => {
    expect(await describeImageFacts(Buffer.from('nope'), '1:1')).toBeNull();
  });
});
