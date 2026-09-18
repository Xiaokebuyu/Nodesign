/**
 * 生成图文件夹（09-18）：旧板迁移只跑一次、只标桌面上已有坐标的生成图；前后端镜像逐字一致。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-genfolder-'));
process.env.PROJECTS_DATA_DIR = tmp;
const { isDeskPinned, inGeneratedDir, GENERATED_DIR, GENERATED_TITLE } = await import('./generated-folder.js');
const { ensureGeneratedFolder } = await import('../projects/generated-folder-migrate.js');
const { readBoard } = await import('../projects/board-store.js');

const here = path.dirname(fileURLToPath(import.meta.url));

describe('ensureGeneratedFolder（旧板迁移）', () => {
  // 板上条目一律带坐标（sanitize 缺省补 0），所以「有条目」就是「已经摆在桌面上」；没条目的是还没入座的
  it('⭐ 板上已有条目的生成图打 desk；别处的不动；第二次不再跑', async () => {
    const pid = 'proj_genfold0001_mv';
    const root = path.join(tmp, pid, 'shared');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'board.json'), JSON.stringify({
      zones: {},
      objects: {
        'assets/generated/a.png': { x: 10, y: 20 },
        'hero.png': { x: 1, y: 1 },
      },
      bindings: {},
    }));
    expect(await ensureGeneratedFolder(pid)).toBe(1);
    const b = await readBoard(pid);
    expect(b.objects['assets/generated/a.png'].desk).toBe(true);
    expect(b.objects['hero.png'].desk).toBeUndefined();
    // 迁过之后新落的图不再被标（它该进文件夹）
    fs.writeFileSync(path.join(root, 'board.json'), JSON.stringify({ ...b, objects: { ...b.objects, 'assets/generated/c.png': { x: 5, y: 5 } } }));
    expect(await ensureGeneratedFolder(pid)).toBe(0);
    expect((await readBoard(pid)).objects['assets/generated/c.png'].desk).toBeUndefined();
  });
});

describe('判据', () => {
  it('desk 只在生成图目录里的文件上算数', () => {
    expect(isDeskPinned('assets/generated/a.png', { desk: true })).toBe(true);
    expect(isDeskPinned('素材/a.png', { desk: true })).toBe(false);
    expect(isDeskPinned('assets/generated/a.png', {})).toBe(false);
    expect(inGeneratedDir('assets/generated/a.png')).toBe(true);
    expect(inGeneratedDir('assets/generated/.meta/a.json')).toBe(false);
  });

  it('⭐ 前端镜像逐字一致（两个常量 + 判据）', () => {
    const web = fs.readFileSync(path.join(here, '../../web/src/lib/generated-folder.js'), 'utf8');
    const srv = fs.readFileSync(path.join(here, 'generated-folder.js'), 'utf8');
    const fn = (s) => /export function isDeskPinned[\s\S]*?\n}/.exec(s)?.[0];
    expect(fn(web)).toBeTruthy();
    expect(fn(web)).toBe(fn(srv));
    expect(web).toContain(`export const GENERATED_DIR = '${GENERATED_DIR}';`);
    expect(web).toContain(`export const GENERATED_TITLE = '${GENERATED_TITLE}';`);
  });
});
