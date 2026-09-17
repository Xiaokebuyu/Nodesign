// 09-17 问题库参数族：同名参数上限对齐、越界报文说人话
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { NODES, PLACE } from './write-on-board-schema.js';

describe('write_on_board 参数报文', () => {
  it('w 越界时写明是格数不是像素（iss_mtfs1kc6_e5ib）', () => {
    const r = NODES.safeParse([{ id: 'a', text: 'x', w: 240 }]);
    expect(r.success).toBe(false);
    expect(r.error.issues[0].message).toMatch(/grid units.*24px/);
  });
  it('tag 不合法时报人话、不打印正则；间隔号收下', () => {
    const r = PLACE.safeParse({ with: '莉莉 安' });
    expect(r.success).toBe(false);
    expect(r.error.issues[0].message).toMatch(/1-40 chars/);
    expect(r.error.issues[0].message).not.toMatch(/\\u4e00/);
    expect(PLACE.safeParse({ with: '莉莉·安' }).success).toBe(true);
  });
});

describe('browser_screenshot 与 screenshot_canvas 的 frames 上限一致（iss_mu0i9kth_dwe2）', () => {
  it('两处源码都写 30000', async () => {
    const fs = await import('node:fs');
    const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    const max = (src) => src.match(/frames:\s*z\s*\.?array\(z\.number\(\)\.min\(0\)\.max\((\d+)\)\)/)?.[1];
    expect(max(read('./browse-screenshot.js'))).toBe('30000');
    // 09-17：screenshot_canvas 的 schema 拆去 screenshot-schema.js（行数棘轮）
    expect(max(read('./screenshot-schema.js').replace(/\n\s*\./g, '.'))).toBe('30000');
  });
});
