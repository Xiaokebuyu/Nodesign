/**
 * canvas-id 归一化钉子（2026-08-14 可维护性行动 D 刀）。
 * read_board / arrange_on_board / create_on_board / organize_board 共用的
 * id 口径 —— agent 传参五花八门，规则漂了就是"摆位工具突然找不到卡"。
 */
import { describe, it, expect } from 'vitest';
import { normalizeCanvasId, layerOf } from './canvas-id.js';

describe('normalizeCanvasId', () => {
  it('反斜杠 / ./ 前缀 / 首尾斜杠全归一', () => {
    expect(normalizeCanvasId('.\\稿件\\主稿.html')).toBe('deck:稿件/主稿.html');
    expect(normalizeCanvasId('./assets/a.png')).toBe('assets/a.png');
    expect(normalizeCanvasId('/素材/图.png/')).toBe('素材/图.png');
  });

  it('裸 .html 补 deck: 前缀；已带 kind 前缀的不重复补', () => {
    expect(normalizeCanvasId('主稿.html')).toBe('deck:主稿.html');
    expect(normalizeCanvasId('deck:主稿.html')).toBe('deck:主稿.html');
    expect(normalizeCanvasId('site:鉴赏页')).toBe('site:鉴赏页');
  });

  it('记忆文件就是普通路径 id（doc: 特例 08-24 拆除）', () => {
    expect(normalizeCanvasId('记忆/style-anchor.md')).toBe('记忆/style-anchor.md');
    expect(normalizeCanvasId('CLAUDE.md')).toBe('CLAUDE.md');
  });

  it('空 / 越界拒收', () => {
    expect(normalizeCanvasId('')).toBe(null);
    expect(normalizeCanvasId('../外面.png')).toBe(null);
  });
});

describe('layerOf', () => {
  const folders = new Set(['稿件', '稿件/初稿']);
  it('带路径的物件不认显式 zone（09-07：归属由路径回答，存量脏字段自愈）', () => {
    expect(layerOf('assets/a.png', { zone: '素材' }, folders)).toBe('');
    // 入座器写过 zone:'' 的卡被搬进文件夹：路径说了算
    expect(layerOf('稿件/x.png', { zone: '' }, folders)).toBe('稿件');
    // 反向：从文件夹搬回根，旧的 zone 也钉不住它
    expect(layerOf('x.png', { zone: '稿件' }, folders)).toBe('');
  });
  it('画布原生物件（带 kind）才认显式 zone，且只认真实存在的层', () => {
    expect(layerOf('text:abc', { kind: 'text', zone: '稿件' }, folders)).toBe('稿件');
    expect(layerOf('text:abc', { kind: 'text', zone: '素材' }, folders)).toBe('');
    expect(layerOf('text:abc', { kind: 'text', zone: '' }, folders)).toBe('');
  });
  it('沿路径找第一个已知文件夹；找不到归根', () => {
    expect(layerOf('deck:稿件/初稿/主稿.html', null, folders)).toBe('稿件/初稿');
    expect(layerOf('别处/深/文件.csv', null, folders)).toBe('');
    expect(layerOf('doc:_root', null, folders)).toBe('');
  });
});

/**
 * 座次装饰要剥掉（2026-09-10）。
 *
 * 现场：站主 09-10 那个会话里，每轮注入的工作台状态印的是 `browse@(48,10)640x388`，
 * agent 把它当 id 喂回 write_on_board 的 near（`browse@48,10`），拿回一句「既没有座位」——
 * 而座位就在 (48,10)。印的那头已经改成带空格；这里是存量与手误的兜底。
 * 边界钉死：正常文件名里的 `@`（logo@2x.png）不许被咬掉。
 */
describe('normalizeCanvasId：剥座次装饰', () => {
  it('黏在 id 后面的坐标/尺寸都剥掉', () => {
    expect(normalizeCanvasId('browse@48,10')).toBe('browse');
    expect(normalizeCanvasId('browse@(48,10)640x388')).toBe('browse');
    expect(normalizeCanvasId('notes/板书/a.md@(711,-140)432x384')).toBe('notes/板书/a.md');
    expect(normalizeCanvasId('参考图/x.jpg @(0,0) 200x176')).toBe('参考图/x.jpg');
  });

  it('⛔ 文件名里本来就有的 @ 不许动', () => {
    expect(normalizeCanvasId('参考图/logo@2x.png')).toBe('参考图/logo@2x.png');
    expect(normalizeCanvasId('a@1,2 b')).toBe('a@1,2 b');       // 坐标不在结尾 = 不是装饰
    expect(normalizeCanvasId('deck:主稿.html')).toBe('deck:主稿.html');
  });
});
