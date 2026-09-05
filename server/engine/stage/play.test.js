import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { listPlays, isPlayDir, migrateLegacyPlay, playFolderName, readPlayConfig } from './play.js';

/** 一场戏一个文件夹：发现 + 老形状迁移。迁移只做一次，做完老目录没了、cast 里的路径跟着搬。 */
const tmps = [];
async function ws(files = {}) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-play-'));
  tmps.push(d);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(d, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  }
  return d;
}
afterAll(async () => { await Promise.all(tmps.map(d => fs.rm(d, { recursive: true, force: true }))); });

describe('发现', () => {
  it('有 戏.json 或 台面.md 的一级文件夹是戏；别的不是', async () => {
    const d = await ws({ 'A/戏.json': '{}', 'B/台面.md': 'x', 'C/readme.md': 'x', '.hidden/戏.json': '{}' });
    expect(await listPlays(d)).toEqual(['A', 'B']);
    expect(await isPlayDir(path.join(d, 'C'))).toBe(false);
  });
  it('文件夹名剥掉路径分隔和点前缀', () => {
    expect(playFolderName('晴可 · 同桌')).toBe('晴可 · 同桌');
    expect(playFolderName('../x/y')).toBe('xy');
    expect(playFolderName('')).toBe('演出');
  });
});

describe('老形状迁移', () => {
  it('stage/ + 根上的 角色/ 世界书/ 收进一个文件夹，cast 路径跟着改，stage/ 删掉', async () => {
    const d = await ws({
      'stage/stage.json': JSON.stringify({ title: '晴可 · 同桌', cast: [{ name: '晴可', card: '角色/晴可/角色卡.md', portrait: '角色/晴可/立绘.png' }], skin: 'night', systemPrompt: '老提示词' }),
      'stage/scenes.jsonl': '{"by":"stage","text":"x"}\n',
      'stage/memory/INDEX.md': '# idx',
      'stage/memory/a.md': 'a',
      '角色/晴可/角色卡.md': '# 晴可',
      '角色/晴可/立绘.png': 'png',
      '世界书/常驻/世界观.md': 'w',
      '用户内容/1.png': 'p',
      'CLAUDE.md': '# 档案',
    });
    const name = await migrateLegacyPlay(d);
    expect(name).toBe('晴可 · 同桌');
    const play = path.join(d, name);
    for (const rel of ['戏.json', '台面.md', '场景/scenes.jsonl', '记忆/INDEX.md', '记忆/a.md', '角色/晴可/角色卡.md', '角色/晴可/立绘.png', '世界书/常驻/世界观.md', '素材/1.png']) {
      await expect(fs.access(path.join(play, rel)), rel).resolves.toBeUndefined();
    }
    await expect(fs.access(path.join(d, 'stage'))).rejects.toThrow();
    await expect(fs.access(path.join(d, '角色'))).rejects.toThrow();
    await expect(fs.access(path.join(d, 'CLAUDE.md'))).resolves.toBeUndefined();   // 主 agent 的档案不动
    const cfg = await readPlayConfig(play);
    expect(cfg.cast[0].card).toBe(`${name}/角色/晴可/角色卡.md`);
    expect(cfg.cast[0].portrait).toBe(`${name}/角色/晴可/立绘.png`);
    expect(cfg.systemPrompt).toBeUndefined();
    expect(await fs.readFile(path.join(play, '台面.md'), 'utf8')).toContain('老提示词');   // 没有台面文件的老戏，提示词变成台面
    expect(await listPlays(d)).toEqual([name]);
  });
  it('已经有戏的文件夹就不迁；没有老形状也不迁', async () => {
    const d = await ws({ 'stage/stage.json': '{}', 'X/戏.json': '{}' });
    expect(await migrateLegacyPlay(d)).toBeNull();
    expect(await migrateLegacyPlay(await ws({ 'Y/戏.json': '{}' }))).toBeNull();
  });
});
