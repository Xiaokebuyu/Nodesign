/**
 * generate_image 批量扇出（2026-09-12）：prompts[] 在一次调用里并发出 N 张，
 * 并发上限 IMAGE_CONCURRENCY，一张失败不拖累其余，全败才 isError。
 */
import { describe, it, expect, vi } from 'vitest';
import { fanOutImages, IMAGE_CONCURRENCY, buildOutputName } from './generate-image-support.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('fanOutImages', () => {
  it('没有 prompts 走老路（一张）', async () => {
    const one = vi.fn(async (a) => ({ content: [{ type: 'text', text: a.prompt }] }));
    const r = await fanOutImages({ prompt: 'p' }, {}, one);
    expect(one).toHaveBeenCalledTimes(1);
    expect(r.content[0].text).toBe('p');
  });
  it('⭐ N 张并发、上限 IMAGE_CONCURRENCY、顺序按 prompts 排、outputName 加 -i', async () => {
    let inflight = 0; let peak = 0;
    const one = vi.fn(async (a) => {
      inflight += 1; peak = Math.max(peak, inflight);
      await sleep(20);
      inflight -= 1;
      return { content: [{ type: 'text', text: `ok ${a.prompt} ${a.outputName}` }, { type: 'image', data: 'x', mimeType: 'image/webp' }] };
    });
    const prompts = ['一', '二', '三', '四', '五', '六'];
    const r = await fanOutImages({ prompts, aspectRatio: '1:1', outputName: 'cat' }, {}, one);
    expect(one).toHaveBeenCalledTimes(6);
    expect(peak).toBe(IMAGE_CONCURRENCY);
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/6 prompts/);
    const texts = r.content.filter((c) => c.type === 'text').map((c) => c.text);
    expect(texts.filter((t) => /^ok /.test(t))).toEqual(prompts.map((p, i) => `ok ${p} cat-${i + 1}`));
    expect(r.content.filter((c) => c.type === 'image')).toHaveLength(6);
    expect(one.mock.calls.every(([a]) => a.aspectRatio === '1:1' && !('prompts' in a))).toBe(true);
  });
  it('一张失败不拖累其余；全败才 isError；不跟 variationOf 混用', async () => {
    const one = vi.fn(async (a) => { if (a.prompt === 'bad') throw new Error('boom'); return { content: [{ type: 'text', text: 'ok' }] }; });
    const r = await fanOutImages({ prompts: ['good', 'bad'] }, {}, one);
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/1 succeeded, 1 failed/);
    const all = await fanOutImages({ prompts: ['bad', 'bad'] }, {}, one);
    expect(all.isError).toBe(true);
    const mixed = await fanOutImages({ prompts: ['a', 'b'], variationOf: 'x.png' }, {}, one);
    expect(mixed.isError).toBe(true);
  });
  it('输出命名：给了名字就清洗，没给就 gen-<ts>-<role>', () => {
    expect(buildOutputName('封面 图/1', 'hero')).toBe('1');   // 非 ASCII 段换成 -，首尾 - 去掉
    expect(buildOutputName('', 'hero')).toMatch(/^gen-\d+-hero$/);
  });
});
