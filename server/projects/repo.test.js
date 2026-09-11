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

describe('改道安全网：快照 / 结算 / 回退', () => {
  it('开工拍树、结算算差异、回退还原改动并删掉新建的', async () => {
    const { recordTurnStart, recordTurnEnd, listTurns, revertToTurn, snapshotTree } = await import('./repo.js');
    // 先把 beforeAll 留下的改动当"用户自己的"：回退只该回到这轮开工时的样子，不是 HEAD
    const before = fs.readFileSync(path.join(dir, 'src', 'index.js'), 'utf8');   // 'export const a = 2;\n'（用户自己改的）
    recordTurnStart(pid, { runId: 'run_t1', sessionId: 'sess_1' });
    await new Promise(r => setTimeout(r, 300));
    // agent 这一轮：改一个、新一个、删一个
    fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'export const a = 3;\n');
    fs.writeFileSync(path.join(dir, 'src', 'agent-made.js'), 'export {}\n');
    fs.rmSync(path.join(dir, 'README.md'));
    const changed = await recordTurnEnd(pid, 'run_t1');
    expect(changed.map(c => `${c.status} ${c.rel}`).sort()).toEqual(['A src/agent-made.js', 'D README.md', 'M src/index.js']);
    const turns = await listTurns(pid);
    expect(turns[0].runId).toBe('run_t1');
    expect(turns[0].changed.length).toBe(3);
    // 回退：改的回到开工时（a = 2，不是 HEAD 的 a = 1）、删的回来、新建的删掉；git 索引和 HEAD 不动
    const out = await revertToTurn(pid, 'run_t1');
    expect(out.restored.sort()).toEqual(['README.md', 'src/index.js']);
    expect(out.removed).toEqual(['src/agent-made.js']);
    expect(fs.readFileSync(path.join(dir, 'src', 'index.js'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'src', 'agent-made.js'))).toBe(false);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(git(dir, 'diff', '--cached', '--name-only').trim()).toBe('');   // 索引没被碰
    // 回退后再拍一棵树，跟开工快照一样
    const now = await snapshotTree(dir);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, '.nodesign', 'turns.json'), 'utf8')).find(t => t.runId === 'run_t1');
    expect(now).toBe(rec.tree);
    // 临时索引文件没留下
    expect(fs.readdirSync(path.join(dir, '.git')).filter(n => n.startsWith('nd-index-'))).toEqual([]);
  });
  // 09-11：用户的 git 开着 core.autocrlf=true（Git for Windows 安装器的默认）时，回退不能改换行符。
  // 原来快照 add 会把 CRLF 收成 LF、restore 再按 autocrlf 写回 CRLF：LF 的文件回退完变成 CRLF，那不叫还原。
  // 在仓库配置里打开 autocrlf，Linux 上也复现得出来（外部审计是在 Windows runner 上撞到的）。
  it('⛔ core.autocrlf=true 的仓库：回退后字节原样（LF 还是 LF，CRLF 还是 CRLF）', async () => {
    const { recordTurnStart, recordTurnEnd, revertToTurn } = await import('./repo.js');
    const d = path.join(tmp, 'crlf-site');
    fs.mkdirSync(d, { recursive: true });
    const LF = 'export const a = 1;\nexport const b = 2;\n';
    const CRLF = 'line one\r\nline two\r\n';
    fs.writeFileSync(path.join(d, 'lf.js'), LF);
    fs.writeFileSync(path.join(d, 'crlf.txt'), CRLF);
    git(d, 'init', '-q', '-b', 'main');
    git(d, 'config', 'core.autocrlf', 'true');
    git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
    git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'first');
    const { project } = await openFolder({ path: d });
    recordTurnStart(project.id, { runId: 'run_crlf', sessionId: 'sess_c' });
    await new Promise(r => setTimeout(r, 300));
    fs.writeFileSync(path.join(d, 'lf.js'), 'export const a = 9;\n');
    fs.writeFileSync(path.join(d, 'crlf.txt'), 'changed\r\n');
    await recordTurnEnd(project.id, 'run_crlf');
    const out = await revertToTurn(project.id, 'run_crlf');
    expect(out.restored.sort()).toEqual(['crlf.txt', 'lf.js']);
    expect(fs.readFileSync(path.join(d, 'lf.js'), 'utf8')).toBe(LF);
    expect(fs.readFileSync(path.join(d, 'crlf.txt'), 'utf8')).toBe(CRLF);
  });
  it('不是仓库项目：开工什么都不记、结算回 null', async () => {
    const { recordTurnStart, recordTurnEnd } = await import('./repo.js');
    recordTurnStart('proj_nope0000_none', { runId: 'x' });
    expect(await recordTurnEnd('proj_nope0000_none', 'x')).toBeNull();
  });
});

describe('分支纪律：开工前机器备好 git、切到 nodesign/ 分支', () => {
  it('干净的仓库：切到 nodesign/<日期> 分支；再来一轮不动', async () => {
    const { ensureWorkBranch, WORK_BRANCH_PREFIX } = await import('./repo.js');
    // beforeAll 留下的改动先清干净（上面的回退测试已经还原过，这里再保险一次）
    git(dir, 'checkout', '--', '.'); git(dir, 'clean', '-fdq', '--', 'src');
    const a = await ensureWorkBranch(pid);
    expect(a.action).toBe('branched');
    expect(a.branch.startsWith(WORK_BRANCH_PREFIX)).toBe(true);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(a.branch);
    const b = await ensureWorkBranch(pid);
    expect(b.action).toBe('already');
    expect(b.branch).toBe(a.branch);
  });
  it('不干净的 main：不切分支，报 dirty 数', async () => {
    const { ensureWorkBranch } = await import('./repo.js');
    git(dir, 'switch', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'README.md'), '# dirty\n');
    const r = await ensureWorkBranch(pid);
    expect(r.action).toBe('dirty');
    expect(r.dirty).toBe(1);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    git(dir, 'checkout', '--', 'README.md');
  });
  it('没有 git 的文件夹：init、exclude 里有 .nodesign 和 node_modules、根提交、再切分支', async () => {
    const { ensureWorkBranch } = await import('./repo.js');
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(path.join(plain, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(plain, 'app.py'), 'print(1)\n');
    const { project } = await openFolder({ path: plain });
    const r = await ensureWorkBranch(project.id);
    expect(r.action).toBe('branched');
    expect(fs.existsSync(path.join(plain, '.git'))).toBe(true);
    const exclude = fs.readFileSync(path.join(plain, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toMatch(/^\.nodesign\/$/m);
    expect(exclude).toMatch(/^node_modules\/$/m);
    expect(git(plain, 'log', '--format=%s', 'main').trim()).toBe('NoDesign 接手前的样子');
    expect(git(plain, 'ls-tree', '--name-only', 'main').trim().split('\n')).toEqual(['app.py']);   // node_modules 没进
    expect(git(plain, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(r.branch);
  });
});
