import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { boardHeroId, heroSize, pickHero, heroAfterLine } from './board-hero.js';

const slice = (src) => {
  const a = src.indexOf('const ELIGIBLE');
  const b = src.indexOf('// ── END-MIRROR') > 0 ? src.indexOf('// ── END-MIRROR') : src.length;
  return src.slice(a, b).replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s+/g, ' ').trim();
};

describe('board-hero 镜像', () => {
  it('pickHero 函数体与 web/src/lib/hero.js 逐字一致', () => {
    const be = fs.readFileSync(new URL('./board-hero.js', import.meta.url), 'utf8');
    const fe = fs.readFileSync(new URL('../../web/src/lib/hero.js', import.meta.url), 'utf8');
    expect(slice(be)).toBe(slice(fe));
  });
  it('唯一产物卡 = 天然主角；显式 hero 覆盖；主角尺寸 1.5 倍', () => {
    const board = { objects: { 'site:a': { x: 0, y: 0 }, 'assets/x.png': { x: 0, y: 0 } }, zones: {}, bindings: {} };
    expect(boardHeroId(board)).toBe('site:a');
    expect(heroSize('site:a')).toEqual({ w: 960, h: 28 + 600 });
    const two = { objects: { 'site:a': { x: 0, y: 0 }, 'site:b': { x: 0, y: 0 } }, zones: {}, bindings: {} };
    expect(boardHeroId(two)).toBeNull();
    expect(boardHeroId({ ...two, hero: 'site:b' })).toBe('site:b');
    expect(pickHero([], {})).toBeNull();
  });
});

describe('heroAfterLine（2026-09-05）', () => {
  it('⭐ 并列无主角时，给其中一张拉一根手画线 → 它会成主角；已是主角的报 false；非产物报 false', () => {
    const board = { objects: { 'deck:a/index.html': { x: 0, y: 0 }, 'site:b': { x: 0, y: 900 }, 'assets/c.png': { x: 0, y: 0 } }, bindings: {}, zones: {} };
    expect(boardHeroId(board)).toBeNull();
    expect(heroAfterLine(board, 'site:b', 'agent')).toBe(true);
    expect(heroAfterLine(board, 'assets/c.png', 'agent')).toBe(false);
    const withLine = { ...board, bindings: { l: { type: 'annotates', from: 'x', to: 'site:b', by: 'agent' } } };
    expect(boardHeroId(withLine)).toBe('site:b');
    expect(heroAfterLine(withLine, 'site:b', 'agent')).toBe(false);
  });
});
