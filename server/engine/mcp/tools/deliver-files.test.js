// deliver_files 收文件夹（09-09 案：用户标注站点文件夹说「打包发给我」，agent 传文件夹名被拒）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';
import { collectDir, makeDeliverFilesTool } from './deliver-files.js';

let root;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-deliver-'));
  await fs.mkdir(path.join(root, 'site/assets'), { recursive: true });
  await fs.mkdir(path.join(root, 'site/node_modules/x'), { recursive: true });
  await fs.mkdir(path.join(root, 'site/.git'), { recursive: true });
  await fs.writeFile(path.join(root, 'site/index.html'), '<html>');
  await fs.writeFile(path.join(root, 'site/assets/a.png'), 'png');
  await fs.writeFile(path.join(root, 'site/node_modules/x/i.js'), 'x');
  await fs.writeFile(path.join(root, 'site/.git/HEAD'), 'ref');
  await fs.writeFile(path.join(root, 'site/.DS_Store'), '');
});
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('collectDir', () => {
  it('递归收文件，跳过 node_modules / .git / 隐藏文件，路径用 /', async () => {
    const out = [];
    await collectDir(root, 'site', out);
    expect(out.map(f => f.rel).sort()).toEqual(['site/assets/a.png', 'site/index.html']);
  });
});

describe('deliver_files 传文件夹', () => {
  it('整个文件夹打成一个 zip，条目带文件夹前缀，emit download_ready', async () => {
    const events = [];
    const t = makeDeliverFilesTool({ workspaceRoot: root, projectId: 'p1', sessionId: 's1', ctx: { emit: (e) => events.push(e) } });
    const res = await t.handler({ paths: ['site'], filename: '官网' }, {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/Delivered 官网\.zip .*2 file\(s\)/);
    const zip = await JSZip.loadAsync(await fs.readFile(path.join(root, 'exports/官网.zip')));
    expect(Object.keys(zip.files).filter(k => !zip.files[k].dir).sort()).toEqual(['site/assets/a.png', 'site/index.html']);
    expect(events[0]).toMatchObject({ type: 'run.download_ready', filename: '官网.zip', count: 2 });
    expect(events[0].url).toMatch(/\/api\/projects\/p1\/sessions\/s1\/exports\/file\/%E5%AE%98%E7%BD%91\.zip$/);
  });
  it('文件夹 + 单个文件混着给也行', async () => {
    const t = makeDeliverFilesTool({ workspaceRoot: root, projectId: 'p1', sessionId: 's1', ctx: {} });
    const res = await t.handler({ paths: ['site/index.html', 'site/assets'] }, {});
    expect(res.content[0].text).toMatch(/2 file\(s\)/);
  });
});
