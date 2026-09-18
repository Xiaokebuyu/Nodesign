import { describe, it, expect } from 'vitest';
import { errText, headTail, headTailBuffer } from './err-text.js';

describe('errText', () => {
  it('⭐ fetch failed 带上 cause 里的真原因（09-18：web_search 整条正文只有 fetch failed）', () => {
    const e = new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
    expect(errText(e)).toBe('fetch failed（read ECONNRESET）');
    const e2 = new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
    expect(errText(e2)).toBe('fetch failed（UND_ERR_SOCKET other side closed）');
  });

  it('没有 cause、cause 已经在 message 里、非 Error 值', () => {
    expect(errText(new Error('配额用完'))).toBe('配额用完');
    expect(errText(new Error('x（boom）', { cause: new Error('boom') }))).toBe('x（boom）');
    expect(errText('字符串')).toBe('字符串');
    expect(errText(null)).toBe('unknown error');
  });
});

describe('headTail / headTailBuffer（09-18：子进程报错原来只留结尾，开头被切）', () => {
  it('⭐ 长报错留头留尾', () => {
    const s = 'HEAD-' + 'x'.repeat(2000) + '-TAIL';
    const r = headTail(s, 10, 10);
    expect(r.startsWith('HEAD-xxxxx')).toBe(true);
    expect(r.endsWith('xxxxx-TAIL')).toBe(true);
    expect(r).toContain('中间省略');
    expect(headTail('短的')).toBe('短的');
  });

  it('⭐ 缓冲分块喂进来，开头不丢', () => {
    const b = headTailBuffer(8, 8);
    for (const chunk of ['{"error":', ' "clip_name" ', 'x'.repeat(50), ' END']) b.push(chunk);
    expect(b.text().startsWith('{"error"')).toBe(true);
    expect(b.text().endsWith('xxxx END')).toBe(true);
    const small = headTailBuffer(8, 8); small.push('abc'); small.push('def');
    expect(small.text()).toBe('abcdef');
  });
});
