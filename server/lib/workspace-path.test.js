/**
 * workspace-path.test.js —— 这个文件在 2026-09-08 之前**一个测试都没有**，
 * 而它在 Windows 上是恒定失败的。
 *
 * ## 为什么非要 win32 那一半
 *
 * `toWorkspaceRel` 原来的写法是「把入参的 `\` 换成 `/`，再拿它 `startsWith(root + path.sep)`」。
 * 在 Linux 上 `path.sep === '/'`，那次归一化正好跟 root 对齐，**永远绿**；
 * 在 Windows 上 root 是 `path.resolve` 出来的反斜杠串，正斜杠 startsWith 反斜杠
 * 永远 false，于是函数恒定退回绝对路径。
 *
 * 后果全是静默的：`run.file_changed` 一个都不发（agent 写完文件画布不动）、
 * 画布上长出一块名叫 `C:` 的影子文件夹。**没有一条会报错**，所以只靠 Linux 上跑测试
 * 永远发现不了。
 *
 * ⚠️ 这里用 `vi.mock` 把 `node:path` 换成 `path.win32`，跑的是**模块本身的代码**。
 * 不能改成「在测试里用 path.win32 重写一遍逻辑再对比」—— 那只证明两份拷贝一致，
 * 证明不了线上那份是对的。
 *
 * 全仓带 `win32` 的测试原来只有 3 个，大小写/盘符这一整类是零覆盖。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

describe('toWorkspaceRel · posix', () => {
  it('绝对路径转相对、相对原样、根自己是空串、根外原样退回', async () => {
    const { toWorkspaceRel } = await import('./workspace-path.js');
    const root = '/home/x/ws';
    expect(toWorkspaceRel('/home/x/ws/稿件/主稿.html', root)).toBe('稿件/主稿.html');
    expect(toWorkspaceRel('稿件/主稿.html', root)).toBe('稿件/主稿.html');
    expect(toWorkspaceRel(root, root)).toBe('');
    expect(toWorkspaceRel('/etc/passwd', root)).toBe('/etc/passwd');
    expect(toWorkspaceRel('', root)).toBe('');
  });
});

describe('toWorkspaceRel · win32（09-08 之前这一整组都是坏的）', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('node:path', () => ({ default: path.win32, ...path.win32 }));
  });
  afterEach(() => { vi.doUnmock('node:path'); vi.resetModules(); });

  /** 真实用户的家目录就是中文的（`C:\Users\笑不语\`），所以样本一律用它 */
  const ROOT = 'C:\\Users\\笑不语\\.nodesign\\projects\\proj_x\\shared';

  it('⭐ 反斜杠的绝对路径 → 工作区相对路径（原来退回的是绝对路径）', async () => {
    const { toWorkspaceRel } = await import('./workspace-path.js');
    expect(toWorkspaceRel(`${ROOT}\\稿件\\主稿.html`, ROOT)).toBe('稿件/主稿.html');
  });

  it('⭐ 正斜杠的绝对路径也要认（agent 和 SDK 两种写法都会来）', async () => {
    const { toWorkspaceRel } = await import('./workspace-path.js');
    expect(toWorkspaceRel('C:/Users/笑不语/.nodesign/projects/proj_x/shared/稿件/主稿.html', ROOT))
      .toBe('稿件/主稿.html');
  });

  it('⭐ 盘符大小写不一样也要认（path.relative 在 win32 上大小写不敏感）', async () => {
    const { toWorkspaceRel } = await import('./workspace-path.js');
    expect(toWorkspaceRel(`c:\\users\\笑不语\\.nodesign\\projects\\proj_x\\shared\\稿件\\图.png`, ROOT))
      .toBe('稿件/图.png');
  });

  it('工作区根自己 → 空串（原来这里也不成立）', async () => {
    const { toWorkspaceRel } = await import('./workspace-path.js');
    expect(toWorkspaceRel(ROOT, ROOT)).toBe('');
    expect(toWorkspaceRel(ROOT.replace(/\\/g, '/'), ROOT)).toBe('');
  });

  it('相对路径原样过，且统一用正斜杠出去（画布 id 的口径）', async () => {
    const { toWorkspaceRel } = await import('./workspace-path.js');
    expect(toWorkspaceRel('稿件\\主稿.html', ROOT)).toBe('稿件/主稿.html');
    expect(toWorkspaceRel('稿件/主稿.html', ROOT)).toBe('稿件/主稿.html');
  });

  it('⭐ 工作区之外的原样退回 —— 不能悄悄变成一个像相对路径的东西', async () => {
    const { toWorkspaceRel } = await import('./workspace-path.js');
    // 别的盘
    expect(toWorkspaceRel('D:\\别处\\x.png', ROOT)).toBe('D:/别处/x.png');
    // 同盘但在根之外
    expect(toWorkspaceRel('C:\\Windows\\System32\\x.dll', ROOT)).toBe('C:/Windows/System32/x.dll');
  });

  it('⭐⭐ 返回值绝不能是绝对路径 —— 那正是当年 `C:` 影子文件夹的来源', async () => {
    const { toWorkspaceRel } = await import('./workspace-path.js');
    const inside = [
      `${ROOT}\\a.png`,
      `${ROOT}/b.png`,
      `${ROOT}\\子\\c.png`,
      'c:/users/笑不语/.nodesign/projects/proj_x/shared/d.png',
    ];
    for (const p of inside) {
      const rel = toWorkspaceRel(p, ROOT);
      expect(path.win32.isAbsolute(rel), `${p} → ${rel} 还是绝对路径`).toBe(false);
      expect(rel.includes('\\'), `${p} → ${rel} 里还有反斜杠`).toBe(false);
      expect(rel.startsWith('C:') || rel.startsWith('c:'), `${p} → ${rel} 带着盘符`).toBe(false);
    }
  });
});
