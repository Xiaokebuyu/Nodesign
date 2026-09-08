import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { writePluginOrigin, readPluginOrigin, setPluginOriginPolicy } from './plugin-origin.js';
import { installPluginToRoot } from './plugin-install.js';
import { loadInstalledPlugins } from '../engine/agent/plugin-loader.js';

const MD = (n) => `---\nname: ${n}\ndescription: 测试用\nversion: 0.1.0\n---\n# ${n}\n`;

describe('plugin-origin：来源记录 + 撤回判决', () => {
  afterEach(() => setPluginOriginPolicy(null));

  it('从市场装的写来源文件；policy 说撤回了就不加载，没来源的和没撤回的照常；policy 抛错按未撤回', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-origin-'));
    process.env.NODESIGN_USER_PLUGINS_DIR = root;
    const uid = 'u_origin';
    const userRoot = path.join(root, uid);
    const a = await installPluginToRoot(Buffer.from(MD('from-market')), userRoot);
    const b = await installPluginToRoot(Buffer.from(MD('my-own')), userRoot);
    const c = await installPluginToRoot(Buffer.from(MD('market-fine')), userRoot);
    expect([a.status, b.status, c.status]).toEqual([201, 201, 201]);
    await writePluginOrigin(a.body.installed.path, { publicationId: 'pub_x_aaaaaa', skillSha256: 'deadbeef' });
    await writePluginOrigin(c.body.installed.path, { publicationId: 'pub_x_bbbbbb', skillSha256: 'cafe' });
    expect((await readPluginOrigin(a.body.installed.path)).publicationId).toBe('pub_x_aaaaaa');
    expect(await readPluginOrigin(b.body.installed.path)).toBeNull();

    const names = async () => (await loadInstalledPlugins({ userId: uid })).plugins.map((p) => path.basename(p.path)).filter((n) => n !== 'nodesign').sort();
    expect(await names()).toEqual(['from-market', 'market-fine', 'my-own']);

    const asked = [];
    setPluginOriginPolicy((o) => { asked.push(o.publicationId); return o.publicationId === 'pub_x_aaaaaa'; });
    expect(await names()).toEqual(['market-fine', 'my-own']);
    expect(asked.sort()).toEqual(['pub_x_aaaaaa', 'pub_x_bbbbbb']);   // 没来源文件的 my-own 不会被问

    setPluginOriginPolicy(() => { throw new Error('库挂了'); });
    expect(await names()).toEqual(['from-market', 'market-fine', 'my-own']);

    // SDK 形态：每个 plugin 都带 skipMcpDiscovery
    const { plugins } = await loadInstalledPlugins({ userId: uid });
    expect(plugins.every((p) => p.type === 'local' && p.skipMcpDiscovery === true)).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });
});
