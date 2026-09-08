/**
 * 仓库卡后端（2026-09-08）：树 / git 状态 / 读文件 / 路径锁。真 git 仓库在临时目录里搭。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-repo-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'data');
const { openFolder } = await import('./folder.js');
const { repoSummary, repoTree, repoFile, _resetStatusCache } = await import('./repo.js');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

let pid;
let dir;
beforeAll(async () => {
  dir = path.join(tmp, 'site');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# site\n');
  fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'README.md', 'src', 'logo.png');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'first commit');
  const out = await openFolder({ path: dir });
  pid = out.project.id;
  // 之后的改动：改一个、新一个
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'export const a = 2;\n');
  fs.writeFileSync(path.join(dir, 'src', 'new.js'), 'export {}\n');
  _resetStatusCache();
});

describe('repoSummary', () => {
  it('分支、HEAD 一行、改动计数', async () => {
    const s = await repoSummary(pid);
    expect(s.name).toBe('site');
    expect(s.git.branch).toBe('main');
    expect(s.git.head.subject).toBe('first commit');
    expect(s.git.counts).toEqual({ modified: 1, added: 0, deleted: 0, untracked: 1 });
    expect(typeof s.baselineAt).toBe('string');
  });
});

describe('repoTree', () => {
  it('根：文件夹在前、不列 .git 和 .nodesign、node_modules 标 ignored、目录聚合改动数', async () => {
    const t = await repoTree(pid, '');
    const names = t.entries.map(e => e.name);
    expect(names).toEqual(['node_modules', 'src', 'logo.png', 'README.md']);   // localeCompare：不分大小写
    expect(names).not.toContain('.git');
    expect(names).not.toContain('.nodesign');
    expect(t.entries.find(e => e.name === 'node_modules').ignored).toBe(true);
    expect(t.entries.find(e => e.name === 'src').changes).toBe(2);
    expect(t.git).toBe(true);
  });
  it('子目录：每个文件带自己的状态字母', async () => {
    const t = await repoTree(pid, 'src');
    const by = Object.fromEntries(t.entries.map(e => [e.name, e]));
    expect(by['index.js'].status).toBe('M');
    expect(by['new.js'].status).toBe('?');
    expect(by['index.js'].size).toBe(20);
  });
  it('路径锁：.. 和跳出去的都拒', async () => {
    await expect(repoTree(pid, '../')).rejects.toMatchObject({ code: 'REPO_PATH_OUTSIDE' });
    await expect(repoTree(pid, 'src/../../data')).rejects.toMatchObject({ code: 'REPO_PATH_OUTSIDE' });
    await expect(repoTree(pid, 'nope')).rejects.toMatchObject({ code: 'REPO_NOT_FOUND' });
  });
});

describe('repoFile', () => {
  it('文本读回来；二进制不读', async () => {
    const f = await repoFile(pid, 'src/index.js');
    expect(f.text).toBe('export const a = 2;\n');
    expect(f.binary).toBe(false);
    const b = await repoFile(pid, 'logo.png');
    expect(b.binary).toBe(true);
    expect(b.text).toBeNull();
  });
  it('目录不是文件', async () => {
    await expect(repoFile(pid, 'src')).rejects.toMatchObject({ code: 'REPO_NOT_FILE' });
  });
});
