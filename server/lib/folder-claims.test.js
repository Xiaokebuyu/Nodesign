/**
 * 文件夹判据（09-17 从 assets.js 收出，iss_mtp465ds_ctko）：站点目录是产物不是文件夹；
 * 入座器与 /artifacts 扫描问的是这一份。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { isCanvasFolder, claimedSubdirs, folderNameAllowed } from './folder-claims.js';

describe('isCanvasFolder：跟 /artifacts 的 collect 递归同判', () => {
  it('⭐ 站点目录、试作目录、构建目录、隐藏目录不是文件夹；普通目录与装着站点的目录是', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-folderclaims-'));
    const put = async (rel, body = 'x') => { await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fs.writeFile(path.join(root, rel), body); };
    await put('十三机兵防卫圈/index.html', '<html></html>');
    await put('十三机兵防卫圈/css/a.css');
    await put('小说/第一章.md');
    await put('作品集/官网/index.html', '<html></html>');
    await put('_drafts/x.html', '<html></html>');
    await put('dist/a.js');
    await put('.nd/x');
    await put('单个文件.md');
    expect(await isCanvasFolder(root, '十三机兵防卫圈')).toBe(false);
    expect(await isCanvasFolder(root, '十三机兵防卫圈/css')).toBe(false);
    expect(await isCanvasFolder(root, '小说')).toBe(true);
    expect(await isCanvasFolder(root, '作品集')).toBe(true);
    expect(await isCanvasFolder(root, '作品集/官网')).toBe(false);
    expect(await isCanvasFolder(root, '_drafts')).toBe(false);
    expect(await isCanvasFolder(root, 'dist')).toBe(false);
    expect(await isCanvasFolder(root, '.nd')).toBe(false);
    expect(await isCanvasFolder(root, '单个文件.md')).toBe(false);   // 文件不是文件夹
    expect(await isCanvasFolder(root, '不存在')).toBe(false);
    expect(await isCanvasFolder(root, 'a/b/c/d')).toBe(false);       // 深度上限 3
  });

  it('认领规则原样：带下级路径的段、目录型产物的顶层段、根站 pages 跨着的子目录', () => {
    const list = [
      { kind: 'site', root: '官网', srcRoot: '官网', entryRel: '官网/index.html', members: undefined },
      { kind: 'site', single: true, root: '', srcRoot: '', file: '_drafts/x.html', entryRel: '_drafts/x.html' },
      { kind: 'site', root: '', srcRoot: '', entryRel: 'index.html', pages: ['index.html', 'posts/1.html'] },
      { kind: 'deck', file: 'canvas.html' },
    ];
    const claimed = claimedSubdirs(list);
    for (const d of ['_drafts', 'posts', '官网']) expect(claimed.has(d), d).toBe(true);
    expect(claimed.has('canvas.html')).toBe(false);   // deck 不是目录型，根层文件名不算认领
    expect(folderNameAllowed('assets', 'assets')).toBe(false);
    expect(folderNameAllowed('参考图', '参考图')).toBe(true);
  });
});
