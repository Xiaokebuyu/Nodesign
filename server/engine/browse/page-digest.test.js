/**
 * browser_read 选择器没命中时给下一步（09-17）：列出页面上实有的地标元素（最多 8 个，带数量），
 * 或提示去掉选择器读全页。原来只有一句「选择器没匹配到元素」。
 */
import { describe, it, expect } from 'vitest';
import { collectPage, pageLandmarks, formatMissing } from './page-digest.js';

/** 假 document：选择器 → 元素数组 */
const fakeDoc = (map) => ({ querySelectorAll: (sel) => map[sel] || [] });
const els = (n) => Array.from({ length: n }, () => ({}));

describe('pageLandmarks', () => {
  it('语义地标带数量；带 id 的容器按 #id 给；总数最多 8', () => {
    const doc = fakeDoc({
      main: els(1), section: els(6), footer: els(1),
      'body [id]': [
        { tagName: 'DIV', id: 'app' }, { tagName: 'SPAN', id: 'inline' }, { tagName: 'SECTION', id: 'pricing' },
        { tagName: 'DIV', id: 'has space' }, { tagName: 'DIV', id: '1bad' },
        ...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ tagName: 'DIV', id })),
      ],
    });
    const lm = pageLandmarks(doc);
    expect(lm.slice(0, 5)).toEqual([
      { sel: 'main', count: 1 }, { sel: 'section', count: 6 }, { sel: 'footer', count: 1 },
      { sel: '#app', count: 1 }, { sel: '#pricing', count: 1 },
    ]);
    expect(lm).toHaveLength(8);
    expect(lm.map((l) => l.sel)).not.toContain('#inline');
    expect(lm.map((l) => l.sel)).not.toContain('#has space');
  });
  it('什么都没有 → 空', () => {
    expect(pageLandmarks(fakeDoc({}))).toEqual([]);
  });
});

describe('collectPage 没命中', () => {
  it('第二次 evaluate 跑 pageLandmarks，结果挂在 data.landmarks 上', async () => {
    const doc = fakeDoc({ article: els(2), 'body [id]': [{ tagName: 'DIV', id: 'root' }] });
    const page = { evaluate: async (fn) => (fn === pageLandmarks ? fn(doc) : { missing: true }) };
    const data = await collectPage(page, { selector: '.pricing' });
    expect(data.missing).toBe(true);
    expect(data.landmarks).toEqual([{ sel: 'article', count: 2 }, { sel: '#root', count: 1 }]);
    const text = formatMissing('.pricing', data).join('\n');
    expect(text).toContain('选择器没匹配到元素：.pricing');
    expect(text).toContain('article（2）、#root（1）');
    expect(text).toContain('去掉 selector 读全页');
  });
  it('地标也没有 → 明说，并仍给「读全页」', () => {
    const text = formatMissing('.x', { missing: true, landmarks: [] }).join('\n');
    expect(text).toContain('没有 main / article / section');
    expect(text).toContain('去掉 selector 读全页');
  });
});
