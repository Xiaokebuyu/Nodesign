import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import JSZip from 'jszip';

import { packableEntries, packPluginDir } from './plugin-pack.js';
import { validateSkillUpload } from './plugin-validator.js';

describe('plugin-pack：导出面和发布面同一张白名单', () => {
  it('只放 plugin.json 与 skills/<id>/ 下的文本和图片；hooks / scripts / agents / .mcp.json 一律不进包', () => {
    const all = [
      '.claude-plugin/plugin.json',
      '.mcp.json',
      'hooks/hooks.json',
      'hooks/run.js',
      'agents/reviewer.md',
      'commands/go.md',
      'skills/a/SKILL.md',
      'skills/a/references/notes.md',
      'skills/a/patterns/cover.png',
      'skills/a/scripts/build.py',
      'skills/a/run.sh',
      'skills/a/index.js',
      'README.md',
    ];
    expect(packableEntries(all)).toEqual([
      '.claude-plugin/plugin.json',
      'skills/a/SKILL.md',
      'skills/a/references/notes.md',
      'skills/a/patterns/cover.png',
    ]);
  });

  it('打出来的 zip 是 plugin-zip 形态，validator 直接认；被剔掉的文件列在 skipped 里', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-pack-'));
    await fs.mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
    await fs.mkdir(path.join(dir, 'skills', 'my-skill', 'scripts'), { recursive: true });
    await fs.mkdir(path.join(dir, 'hooks'), { recursive: true });
    await fs.writeFile(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'my-skill', version: '1.0.0', description: 'd' }));
    await fs.writeFile(path.join(dir, 'skills', 'my-skill', 'SKILL.md'), '---\nname: my-skill\ndescription: 用在哪；不用在哪\nversion: 1.0.0\n---\n# x\n');
    await fs.writeFile(path.join(dir, 'skills', 'my-skill', 'scripts', 'x.py'), 'print(1)');
    await fs.writeFile(path.join(dir, 'hooks', 'hooks.json'), '{}');
    const { buffer, files, skipped } = await packPluginDir(dir);
    expect(files).toEqual(['.claude-plugin/plugin.json', 'skills/my-skill/SKILL.md']);
    expect(skipped.sort()).toEqual(['hooks/hooks.json', 'skills/my-skill/scripts/x.py']);
    const zip = await JSZip.loadAsync(buffer);
    expect(Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort()).toEqual(['.claude-plugin/plugin.json', 'skills/my-skill/SKILL.md']);
    const v = await validateSkillUpload(buffer);
    expect(v.ok).toBe(true);
    expect(v.mode).toBe('plugin-zip');
    expect(v.manifest.name).toBe('my-skill');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('没有 SKILL.md 的目录打不了包', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-pack-'));
    await fs.mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
    await fs.writeFile(path.join(dir, '.claude-plugin', 'plugin.json'), '{"name":"x"}');
    await expect(packPluginDir(dir)).rejects.toThrow(/SKILL\.md/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
