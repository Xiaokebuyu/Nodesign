/**
 * 树外素材进包（09-18）：拖出 assets/ 的生成图被站点引用时，发布 / 工程包 / 整站 zip 要带上它。
 * 反例同样要钉：树外的页面不收、assets/ 下的交给老路、站内的不动、磁盘上没有的不动。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bundleOutsideMedia } from './outside-media.js';
import { collectAssetRefs } from './asset-refs.js';

let root;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-outside-'));
  for (const f of ['hero.webp', '素材/a.png', '别的站/index.html', 'assets/generated/b.webp', '站/logo.png']) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), 'x');
  }
});

const run = (text, pageRel = '站/index.html', ext = 'html') => bundleOutsideMedia(text, { ext, pageRel, siteRoot: '站', root });

describe('bundleOutsideMedia', () => {
  it('⭐ 树外素材改到包内 assets/_ws/，并报出要带的文件', () => {
    const out = run('<img src="../hero.webp"><img src="../素材/a.png">');
    expect(out.text).toBe('<img src="assets/_ws/hero.webp"><img src="assets/_ws/素材/a.png">');
    expect(out.files).toEqual([
      { wsRel: 'hero.webp', bundleRel: 'assets/_ws/hero.webp' },
      { wsRel: '素材/a.png', bundleRel: 'assets/_ws/素材/a.png' },
    ]);
  });

  it('子页按自己的深度算前缀；css 的 url() 同样认', () => {
    expect(run('<img src="../../hero.webp">', '站/about/index.html').text).toBe('<img src="../assets/_ws/hero.webp">');
    expect(run('.x{background:url(../hero.webp)}', '站/style.css', 'css').text).toBe('.x{background:url(assets/_ws/hero.webp)}');
  });

  it('不收：树外页面、assets/ 下的（老路负责）、站内的、磁盘上没有的', () => {
    const text = '<a href="../别的站/index.html"></a><img src="../assets/generated/b.webp"><img src="logo.png"><img src="../没有.png">';
    const out = run(text);
    expect(out.text).toBe(text);
    expect(out.files).toEqual([]);
  });

  it('根站没有「树外」：原样返回', () => {
    const out = bundleOutsideMedia('<img src="hero.webp">', { ext: 'html', pageRel: 'index.html', siteRoot: '', root });
    expect(out.files).toEqual([]);
  });
});

describe('collectAssetRefs allowMedia（按卡导出）', () => {
  it('⭐ 树外素材收进 refs，树外页面照旧挡进清单', async () => {
    fs.writeFileSync(path.join(root, '站/index.html'), '<img src="../hero.webp"><a href="../别的站/index.html">x</a>');
    const files = [{ abs: path.join(root, '站/index.html'), rel: '站/index.html' }];
    const off = await collectAssetRefs({ files, baseRoot: root, allowPrefixes: ['站/', 'assets/'] });
    expect(off.refs).not.toContain('hero.webp');
    const on = await collectAssetRefs({ files, baseRoot: root, allowPrefixes: ['站/', 'assets/'], allowMedia: true });
    expect(on.refs).toContain('hero.webp');
    expect(on.refs).not.toContain('别的站/index.html');
    expect(on.unresolved.some((u) => u.snippet.includes('别的站'))).toBe(true);
  });
});
