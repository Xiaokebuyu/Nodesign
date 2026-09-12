import { describe, it, expect } from 'vitest';
import { categoryOf } from './card.js';

// 采集件按文件名分类：窗里按类别决定「点开放大」还是「另开标签页看原件」（2026-09-12）
describe('browse card · categoryOf', () => {
  it('截图 / 其它图 / 文本三类', () => {
    expect(categoryOf('home.screenshot.webp')).toBe('screenshot');
    expect(categoryOf('home.screenshot.png')).toBe('screenshot');
    expect(categoryOf('logo.svg')).toBe('image');
    expect(categoryOf('hero.JPG')).toBe('image');
    expect(categoryOf('palette.json')).toBe('text');
    expect(categoryOf('fonts.md')).toBe('text');
    expect(categoryOf('main.css')).toBe('text');
  });
});
