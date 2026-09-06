import { describe, it, expect } from 'vitest';
import { capImages, omittedImageText } from './image-cap.js';

const img = (n) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: `img${n}` } });
const msgs = () => [
  { role: 'user', content: [{ type: 'text', text: 'a' }, img(1)] },
  { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [img(2), { type: 'text', text: 'r' }] }, img(3)] },
  { role: 'user', content: [img(4), img(5), img(6)] },
];
const images = (m) => m.flatMap((x) => x.content.flatMap((b) => b.type === 'image' ? [b.source.data] : b.type === 'tool_result' ? b.content.filter((i) => i.type === 'image').map((i) => i.source.data) : []));

describe('capImages', () => {
  it('超过上限：最早的换成占位文字，最近 N 张原样保留（tool_result 里的也算）', () => {
    const m = msgs();
    expect(capImages(m, 4)).toBe(2);
    expect(images(m)).toEqual(['img3', 'img4', 'img5', 'img6']);
    expect(m[0].content[1]).toEqual({ type: 'text', text: omittedImageText(4) });
    expect(m[2].content[0].content[0]).toEqual({ type: 'text', text: omittedImageText(4) });
  });
  it('没超 / 没配 / 坏值 → 一张不动', () => {
    const m = msgs();
    expect(capImages(m, 6)).toBe(0);
    expect(capImages(m, null)).toBe(0);
    expect(capImages(m, 0)).toBe(0);
    expect(capImages(undefined, 4)).toBe(0);
    expect(images(m)).toHaveLength(6);
  });
});
