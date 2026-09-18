/**
 * 搬家的后半件（09-18，站主定「真搬文件，画布位置变动代表文件变动」）。
 *
 * 判据先验：每条都给一个**必须跟着动的东西**（webp 另一半、.meta、站点引用、板书锚点），
 * 再配反例（落点已有同名的不覆盖、follow:false 不改引用）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 数据根要在 import workspace.js 之前定（同 move-entry.test.js）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-move-follow-'));
process.env.PROJECTS_DATA_DIR = tmp;
const { moveEntry } = await import('./move-entry.js');
const { companionsOf } = await import('../lib/move-follow.js');

let n = 0; let PID; let root;
const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
const r = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const has = (rel) => fs.existsSync(path.join(root, rel));
const board = () => JSON.parse(r('board.json'));

beforeEach(() => {
  n += 1; PID = `proj_follow${String(n).padStart(4, '0')}_mv`;
  root = path.join(tmp, PID, 'shared');
  w('assets/generated/hero.png', 'png');
  w('assets/generated/hero.webp', 'webp');
  w('assets/generated/.meta/hero.json', '{"prompt":"p"}');
  w('assets/generated/hero.grounding.json', '{}');
  w('assets/generated/.thumbnails/hero.thumb.webp', 't');
  w('落地页/index.html', '<img src="../assets/generated/hero.webp"><link rel="stylesheet" href="style.css">');
  w('落地页/style.css', '.a{background:url(../assets/generated/hero.png)}');
  w('notes/板书/20260918-hero.md', '---\nnd: chalk\nby: agent\nat: 2026-09-18T00:00:00.000Z\nanchor: assets/generated/hero.png\n---\n\n主视觉用这张\n');
  w('board.json', JSON.stringify({
    zones: {}, objects: { 'assets/generated/hero.png': { x: 1, y: 2 }, 'site:落地页': { x: 400, y: 2 } },
    bindings: { 'b:1': { type: 'ref', from: 'site:落地页', to: 'assets/generated/hero.png' } },
  }));
});

describe('moveEntry 搬一张生成图', () => {
  it('⭐ png、webp、.meta、grounding、缩略一起走；画布身份与线端点跟走', async () => {
    const out = await moveEntry(PID, 'assets/generated/hero.png', '');
    expect(out.moved).toBe(true);
    for (const f of ['hero.png', 'hero.webp', '.meta/hero.json', 'hero.grounding.json', '.thumbnails/hero.thumb.webp']) {
      expect(has(f), f).toBe(true);
      expect(has(`assets/generated/${f}`), `旧 ${f}`).toBe(false);
    }
    expect(out.moves.map((m) => m.to).sort()).toEqual(['.meta/hero.json', '.thumbnails/hero.thumb.webp', 'hero.grounding.json', 'hero.png', 'hero.webp']);
    const b = board();
    expect(b.objects['hero.png']).toMatchObject({ x: 1, y: 2 });
    expect(b.bindings['b:1'].to).toBe('hero.png');
  });

  it('⭐ 站点里的引用（html 属性、css url）改到新路径，板书锚点也改', async () => {
    const out = await moveEntry(PID, 'assets/generated/hero.png', '');
    expect(r('落地页/index.html')).toContain('src="../hero.webp"');
    expect(r('落地页/style.css')).toContain('url(../hero.png)');
    expect(r('notes/板书/20260918-hero.md')).toContain('\nanchor: hero.png\n');
    expect(r('notes/板书/20260918-hero.md')).toContain('主视觉用这张');
    expect(out.follow).toMatchObject({ files: 2, hits: 2, anchors: 1 });
  });

  it('搬的是 webp 那一半，png 也跟着走（两个文件是一张卡）', async () => {
    await moveEntry(PID, 'assets/generated/hero.webp', '素材', { createFolder: true });
    expect(has('素材/hero.png')).toBe(true);
    expect(has('素材/.meta/hero.json')).toBe(true);
    expect(r('落地页/index.html')).toContain('src="../素材/hero.webp"');
  });

  it('落点已有同名伴随件：不覆盖，留在原地', async () => {
    w('.meta/hero.json', '{"prompt":"别人的"}');
    await moveEntry(PID, 'assets/generated/hero.png', '');
    expect(r('.meta/hero.json')).toContain('别人的');
    expect(has('assets/generated/.meta/hero.json')).toBe(true);
  });

  it('follow:false 只搬不改引用（批量调用方自己攒齐再改一次）', async () => {
    const out = await moveEntry(PID, 'assets/generated/hero.png', '', { follow: false });
    expect(out.follow).toBeNull();
    expect(r('落地页/index.html')).toContain('../assets/generated/hero.webp');
    expect(has('hero.webp')).toBe(true);
  });
});

describe('companionsOf', () => {
  it('非图非视频没有伴随件；改名时伴随件跟着换名', async () => {
    expect(await companionsOf(root, '落地页/style.css', 'x/style.css')).toEqual([]);
    const c = await companionsOf(root, 'assets/generated/hero.png', '素材/主视觉.png');
    expect(c.map((x) => x.to)).toContain('素材/主视觉.webp');
    expect(c.map((x) => x.to)).toContain('素材/.meta/主视觉.json');
  });
});
