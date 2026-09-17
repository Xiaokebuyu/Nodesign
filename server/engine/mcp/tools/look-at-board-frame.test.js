/**
 * look_at_board 的取景与截图兜底（09-17）：
 *   - around 走共用锚点解析（iss_mtjevkfs_n9dm）：自然叫法认得出、没座位的真文件当场入座、不存在的说清楚
 *   - 截图超时退到 CDP 抓当前帧（iss_mtcl9nps_7q15）
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-lookframe-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { frameAround, captureBoardShot } = await import('./look-at-board-frame.js');
const { readBoard, patchBoard } = await import('../../../projects/board-store.js');
const { getSharedDir, ensureProjectWorkspace } = await import('../../../projects/workspace.js');

const pid = 'proj_lookframe_test';
let root;
beforeAll(async () => {
  await ensureProjectWorkspace(pid);
  root = getSharedDir(pid);
  await fs.mkdir(path.join(root, '角色档案站'), { recursive: true });
  await fs.writeFile(path.join(root, '角色档案站', 'index.html'), '<html><body>x</body></html>');
  await patchBoard(pid, { objects: { 'site:角色档案站': { x: 1000, y: 2000, w: 640, h: 400 } } });
});

describe('frameAround：跟 write_on_board 同一份锚点解析', () => {
  it('⭐ 「角色档案站（site）」「角色档案站/index.html」都框得上站点卡，并说明认成了谁', async () => {
    for (const raw of ['角色档案站（site）', '角色档案站/index.html', 'site:角色档案站']) {
      const f = await frameAround(pid, raw, 100);
      expect(f.error, raw).toBeUndefined();
      expect(f.box.x, raw).toBe(900);
      expect(f.box.y, raw).toBe(1900);
      expect(f.what, raw).toContain('around site:角色档案站');
    }
    expect((await frameAround(pid, '角色档案站（site）')).what).toContain('认成了');
  });

  it('⭐ 盘上有、还没座位的文件：当场入座再框（原来报「还没有座位」）', async () => {
    await fs.writeFile(path.join(root, '新图.png'), Buffer.alloc(8));
    const f = await frameAround(pid, '新图.png');
    expect(f.error).toBeUndefined();
    expect((await readBoard(pid)).objects['新图.png']).toBeTruthy();
  });

  it('⭐ 不存在的东西：说清磁盘上也没有，并给候选（原来说「还没有座位」）', async () => {
    const f = await frameAround(pid, '角色档案馆.png');
    expect(f.error).toContain('磁盘上也没有');
    expect(f.error).not.toContain('还没有座位');
  });
});

describe('captureBoardShot：截图超时退到 CDP 抓当前帧', () => {
  const fakePage = (screenshot, sent = []) => ({
    screenshot,
    context: () => ({
      newCDPSession: async () => ({
        send: async (method, params) => { sent.push([method, params]); return { data: Buffer.from('cdp-frame').toString('base64') }; },
        detach: async () => {},
      }),
    }),
  });

  it('⭐ playwright 超时 → CDP 当前帧，degraded 标出来', async () => {
    const sent = [];
    const r = await captureBoardShot(fakePage(async () => { throw new Error('page.screenshot: Timeout 15000ms exceeded.'); }, sent));
    expect(r.degraded).toBe(true);
    expect(r.buf.toString()).toBe('cdp-frame');
    expect(sent[0][0]).toBe('Page.captureScreenshot');
  });

  it('正常截图不走兜底；非超时错误照抛', async () => {
    let opts = null;
    const ok = await captureBoardShot(fakePage(async (o) => { opts = o; return Buffer.from('png'); }));
    expect(ok).toEqual({ buf: Buffer.from('png'), degraded: false });
    expect(opts.timeout).toBe(15000);   // 不再吃 playwright 默认的 30s
    await expect(captureBoardShot(fakePage(async () => { throw new Error('Target closed'); }))).rejects.toThrow('Target closed');
  });
});
