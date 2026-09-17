/**
 * read_user_view 的选中行（09-17 iss_mtgcjmnf_tye4）：印出来的是能回填的 id，
 * 视口列表那行自带 (id: …)，不重复印。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-readuserview-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { makeReadUserViewTool } = await import('./read-user-view.js');
const { patchBoard } = await import('../../../projects/board-store.js');
const { ensureProjectWorkspace } = await import('../../../projects/workspace.js');
const { setViewpoint, _resetViewpoints } = await import('../../../projects/viewpoint-store.js');

describe('read_user_view', () => {
  it('⭐ 选中行印 site:X（不是 `X（site）`）；视口列表行 id 只印一次', async () => {
    const pid = 'proj_readuserview';
    await ensureProjectWorkspace(pid);
    await patchBoard(pid, { objects: { 'site:鉴赏页': { x: 100, y: 100, w: 640, h: 400 } } });
    _resetViewpoints();
    setViewpoint(pid, { camera: { x: 0, y: 0, w: 1400, h: 900 }, zoom: 1, selected: ['site:鉴赏页'] });
    const r = await makeReadUserViewTool({ projectId: pid }).handler({});
    const text = r.content[0].text;
    expect(text).toContain('选中：site:鉴赏页');
    expect(text).not.toContain('选中：鉴赏页（site）');
    const row = text.split('\n').find((l) => l.startsWith('- ') && l.includes('(id: site:鉴赏页)'));
    expect(row).toBeTruthy();
    expect(row.split('site:鉴赏页').length - 1).toBe(1);
    _resetViewpoints();
  });
});
