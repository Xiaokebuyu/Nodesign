import { describe, it, expect } from 'vitest';
import { sanitizeBoard, sanitizeTag } from './board-sanitize.js';

/** 黑板字段（2026-08-23）：tag / staging / text.format / binding.material 的收与拒 */
describe('board-sanitize 黑板字段', () => {
  it('tag 只收安全字符（进 DOM 属性与 URL），长度 ≤ 40', () => {
    expect(sanitizeTag('sketch-1')).toBe('sketch-1');
    expect(sanitizeTag('头脑风暴_第一轮')).toBe('头脑风暴_第一轮');
    expect(sanitizeTag('a b')).toBeNull();
    expect(sanitizeTag('<x>')).toBeNull();
    expect(sanitizeTag('x'.repeat(41))).toBeNull();
    expect(sanitizeTag(7)).toBeNull();
  });

  it('物件：tag/staging 合法才落字段；plain 不落 format，md 落', () => {
    const b = sanitizeBoard({
      objects: {
        'text:a': { x: 1, y: 2, kind: 'text', data: { t: 'hi', format: 'md' }, tag: 'g1', staging: true },
        'text:b': { x: 1, y: 2, kind: 'text', data: { t: 'yo', format: 'plain' }, tag: 'bad tag', staging: 'yes' },
        'deck:x': { x: 0, y: 0, tag: 'g1' },
      },
    });
    expect(b.objects['text:a']).toMatchObject({ tag: 'g1', staging: true, data: { t: 'hi', format: 'md' } });
    expect(b.objects['text:b'].tag).toBeUndefined();
    expect(b.objects['text:b'].staging).toBeUndefined();
    expect(b.objects['text:b'].data.format).toBeUndefined();
    expect(b.objects['deck:x'].tag).toBe('g1');
  });

  it('正文上限 8000（08-25 移除画板上限批：容量墙只当失控兜底）', () => {
    const long = 'x'.repeat(9000);
    const b = sanitizeBoard({ objects: {
      'text:p': { x: 0, y: 0, kind: 'text', data: { t: long } },
      'text:m': { x: 0, y: 0, kind: 'text', data: { t: long, format: 'md' } },
    } });
    expect(b.objects['text:p'].data.t.length).toBe(8000);
    expect(b.objects['text:m'].data.t.length).toBe(8000);
  });

  it('线：material 只收词汇表里的、ink 不落字段；tag/staging 同物件', () => {
    const b = sanitizeBoard({ bindings: {
      b1: { type: 'link', from: 'a', to: 'b', material: 'yarn', tag: 'g1', staging: true },
      b2: { type: 'link', from: 'a', to: 'c', material: 'ink' },
      b3: { type: 'link', from: 'a', to: 'd', material: 'lava' },
    } });
    expect(b.bindings.b1).toMatchObject({ material: 'yarn', tag: 'g1', staging: true });
    expect(b.bindings.b2.material).toBeUndefined();
    expect(b.bindings.b3.material).toBeUndefined();
  });
});

describe('画布 id 路径安全（fable 08-23 P0）', () => {
  it('拒 `..` 段 / 绝对路径 / 反斜杠；正常 id 与带前缀 id 放行', async () => {
    const { isSafeCanvasId } = await import('./board-sanitize.js');
    expect(isSafeCanvasId('notes/板书/a.md')).toBe(true);
    expect(isSafeCanvasId('deck:海报/x.html')).toBe(true);
    expect(isSafeCanvasId('text:abc')).toBe(true);
    expect(isSafeCanvasId('notes/板书/../../../etc/passwd')).toBe(false);
    expect(isSafeCanvasId('/etc/passwd')).toBe(false);
    expect(isSafeCanvasId('deck:../x.html')).toBe(false);
    expect(isSafeCanvasId('a\\b')).toBe(false);
    const b = sanitizeBoard({ objects: { 'notes/板书/../../x': { x: 1, y: 1, tag: 'boom' }, 'ok.png': { x: 1, y: 1 } } });
    expect(Object.keys(b.objects)).toEqual(['ok.png']);
  });
});

/**
 * lid = sketch_on_board 起的局部节点名（2026-08-25，信箱 iss_mt7mfgt8_m7uf）。
 * 这层是白名单重建，新字段不列进来就静默丢 —— 丢了 edit_sketch 的第三级 id
 * 解析就永远查不到，而且不会有任何报错。所以单独钉一条。
 */
describe('text.data.lid 存活（局部节点名）', () => {
  it('合法 lid 留住，非法/超长/非串一律不落字段', () => {
    const b = sanitizeBoard({
      objects: {
        'text:a': { x: 0, y: 0, kind: 'text', data: { t: 'hi', lid: 'linfan' } },
        'text:b': { x: 0, y: 0, kind: 'text', data: { t: 'hi', lid: '有 空格' } },
        'text:c': { x: 0, y: 0, kind: 'text', data: { t: 'hi', lid: 'x'.repeat(25) } },
        'text:d': { x: 0, y: 0, kind: 'text', data: { t: 'hi', lid: 7 } },
        'text:e': { x: 0, y: 0, kind: 'text', data: { t: 'hi' } },
      },
    });
    expect(b.objects['text:a'].data.lid).toBe('linfan');
    for (const id of ['text:b', 'text:c', 'text:d', 'text:e']) {
      expect(b.objects[id].data.lid).toBeUndefined();
    }
  });

  it('过一遍 sanitize 再过一遍，lid 不会掉（前端回写会反复走这层）', () => {
    const once = sanitizeBoard({ objects: { 'text:a': { x: 0, y: 0, kind: 'text', data: { t: 'hi', lid: 'su-wan' } } } });
    const twice = sanitizeBoard(once);
    expect(twice.objects['text:a'].data.lid).toBe('su-wan');
  });
});

/** 纸（sheet 注册表，2026-08-29 纸范式）：白名单收与拒 + 双程不掉 */
describe('board-sanitize 纸字段', () => {
  it('sheets 合法条目收下：矩形必给，w/h 夹持有兜底，by/at/title 可选', () => {
    const b = sanitizeBoard({ sheets: {
      p1: { x: 0, y: 0, w: 1867, h: 1200, by: 'agent', at: '2026-08-29T01:00:00Z', title: '第一章' },
      p2: { x: 100.4, y: 200.6 },                      // 缺 w/h → 一屏兜底
      p3: { x: 'nan', y: 0 },                          // 坐标非数 → 整条丢
      'bad name!!': { x: 0, y: 0 },                    // 名字过不了 tag 白名单 → 丢
    } });
    expect(b.sheets.p1).toMatchObject({ x: 0, y: 0, w: 1867, h: 1200, by: 'agent', title: '第一章' });
    expect(b.sheets.p2).toMatchObject({ x: 100, y: 201, w: 1867, h: 1200 });
    expect(b.sheets.p3).toBeUndefined();
    expect(b.sheets['bad name!!']).toBeUndefined();
  });

  it('过一遍 sanitize 再过一遍，sheets 一个字段都不掉（白名单重建的老陷阱）', () => {
    const once = sanitizeBoard({ sheets: { p1: { x: 24, y: 48, w: 1000, h: 800, by: 'rp-su-wan', at: '2026-08-29T02:00:00Z', title: '状态板' } } });
    const twice = sanitizeBoard(once);
    expect(twice.sheets.p1).toEqual(once.sheets.p1);
    expect(twice.sheets.p1).toMatchObject({ by: 'rp-su-wan', at: '2026-08-29T02:00:00Z', title: '状态板' });
  });

  it('空 sheets 不落顶层键（diff 里别凭空多一行）', () => {
    expect(sanitizeBoard({ objects: {} }).sheets).toBeUndefined();
  });
});
