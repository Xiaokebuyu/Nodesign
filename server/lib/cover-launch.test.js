/**
 * renderCoverShot 的开浏览器入口（09-17，问题库 iss_mu0v5pa5_3ojg）。
 *
 * 画布远景缩略图（lib/artifact-thumb.js）把「过 gatedBrowser 的那一版」传进来；封面 / 橱窗不传，
 * 照旧直接开。这里钉住：传了就只用传进来的，不传才用默认的；出错也要关浏览器（还槽靠 close）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-cover-launch-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const probe = vi.hoisted(() => ({ defaultLaunches: 0, opened: [] }));
vi.mock('../engine/mcp/tools/helpers/perception-page.js', () => ({
  launchPerceptionBrowser: async () => { probe.defaultLaunches += 1; return { tag: 'default', close: async () => {} }; },
  // 页面打开这一步直接失败：本测试只关心用的是哪只浏览器、失败后关没关
  openArtifactPage: async (browser) => { probe.opened.push(browser.tag); throw new Error('stop here'); },
}));

const { renderCoverShot } = await import('./cover.js');

const entry = path.join(tmp, 'index.html');
await fs.writeFile(entry, '<h1>x</h1>');

beforeEach(() => { probe.defaultLaunches = 0; probe.opened.length = 0; });

describe('renderCoverShot 的 launch 注入', () => {
  it('⭐ 传了 launch：只用它开的浏览器，出错也关掉', async () => {
    const close = vi.fn(async () => {});
    const launch = vi.fn(async () => ({ tag: 'gated', close }));
    await expect(renderCoverShot({ absPath: entry, kind: 'site' }, {}, { launch })).rejects.toThrow('stop here');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(probe.opened).toEqual(['gated']);
    expect(probe.defaultLaunches).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('不传：照旧用默认的（首页封面 / 橱窗不过槽位闸）', async () => {
    await expect(renderCoverShot({ absPath: entry, kind: 'site' }, {})).rejects.toThrow('stop here');
    expect(probe.defaultLaunches).toBe(1);
    expect(probe.opened).toEqual(['default']);
  });
});
