/**
 * 文本文件卡的预览体（2026-08-24 建，2026-08-29 加 json 结构裁剪 + 放开 upload）。
 *
 * 钉两件容易回归的：
 *  ① json 走结构裁剪而不是硬截断 —— 前端画树的前提是 parse 得动
 *  ② **upload 也有预览**。用户上传的角色卡/世界卡住在 用户内容/（kind='upload'），
 *    而条件原来只认 'task-file' —— json 预览器做完才在真板上发现最常见的那一类
 *    json 根本走不到这里，卡面永远是空细条。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-preview-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { decorateFilePreview, PREVIEW_EXTS } = await import('./helpers.js');

let dir;
beforeAll(async () => {
  dir = path.join(tmp, 'files');
  await fs.mkdir(dir, { recursive: true });
});
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

describe('decorateFilePreview', () => {
  it('⭐ json → 结构裁剪，产出仍是合法 json（前端才画得出树）', async () => {
    const p = path.join(dir, 'card.json');
    await fs.writeFile(p, JSON.stringify({
      name: '角色', deep: { a: { b: { c: { d: 1 } } } }, xs: Array.from({ length: 40 }, (_, i) => i),
    }), 'utf8');
    const item = {};
    await decorateFilePreview(item, p);
    expect(item.previewKind).toBe('json');
    expect(() => JSON.parse(item.preview)).not.toThrow();
    expect(JSON.parse(item.preview).name).toBe('角色');
  });

  it('⭐ 不是合法 json 的 .json → 退回原样截断（不假装看得懂）', async () => {
    const p = path.join(dir, 'broken.json');
    await fs.writeFile(p, '{ 写了一半就没了', 'utf8');
    const item = {};
    await decorateFilePreview(item, p);
    expect(item.previewKind).toBeUndefined();
    expect(item.preview).toContain('写了一半');
  });

  it('md 照旧截 1KB，frontmatter 藏掉', async () => {
    const p = path.join(dir, 'a.md');
    await fs.writeFile(p, '---\nsession: abc12345\n---\n# 标题\n正文', 'utf8');
    const item = {};
    await decorateFilePreview(item, p);
    expect(item.preview.startsWith('# 标题')).toBe(true);
    expect(item.previewKind).toBeUndefined();
  });

  it('读不到的文件不炸，只是没有预览', async () => {
    const item = {};
    await decorateFilePreview(item, path.join(dir, '不存在.json'));
    expect(item.preview).toBeUndefined();
  });

  it('⭐ .json 在预览白名单里（放开 upload 那条路的前提）', () => {
    expect(PREVIEW_EXTS.has('.json')).toBe(true);
    expect(PREVIEW_EXTS.has('.md')).toBe(true);
  });
});

/**
 * 路由层的条件（assets.js:331）：upload 和 task-file 都要过预览。
 * 这里读源码断言而不是起服务 —— 判据是"那个条件写没写上"，起整个 express
 * 只为验一个 if 不划算，而这条件一改就是静默回归（卡面变空，不报错）。
 */
describe('artifacts 路由的预览条件', () => {
  it('⭐ upload 和 task-file 都走 decorateFilePreview', async () => {
    const src = await fs.readFile(new URL('../assets.js', import.meta.url), 'utf8');
    const line = src.split('\n').find(l => l.includes('decorateFilePreview(item'));
    expect(line).toBeTruthy();
    const guard = src.split('\n').find(l => l.includes("kind === 'task-file'") && l.includes('PREVIEW_EXTS'));
    expect(guard, '预览条件那一行').toBeTruthy();
    expect(guard).toContain("kind === 'upload'");
  });
});
