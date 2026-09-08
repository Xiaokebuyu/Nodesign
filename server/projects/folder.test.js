/**
 * 文件夹项目（存量仓库道，2026-09-07）：打开 / 接回身份 / 信任门 / 画布根分流。
 * 全在临时目录里跑：数据根、用户「仓库」、库文件（vitest.server.config.js 钉了 DB_PATH）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ⚠️ 数据根必须在 import workspace.js 之前定（PROJECTS_DATA_ROOT 模块加载时从 env 解析）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-folder-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'data');
const { openFolder, inspectFolderTrust, normalizeFolderPath } = await import('./folder.js');
const { getWorkspaceRoot, getAgentCwd, getSessionWorkspace, NODESIGN_DIR } = await import('./workspace.js');
const { getProject } = await import('./store.js');

function mkRepo(name, { settings = null, claudeMd = false, git = true } = {}) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'export {}\n');
  if (git) fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  if (settings) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify(settings));
  }
  if (claudeMd) fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# repo\n');
  return dir;
}

describe('normalizeFolderPath', () => {
  it('去尾部分隔符、绝对化', () => {
    const p = normalizeFolderPath(path.join(tmp, 'a', 'b') + path.sep);
    expect(p).toBe(path.join(tmp, 'a', 'b'));
  });
  it('盘根不能当项目', () => {
    expect(() => normalizeFolderPath(path.parse(tmp).root)).toThrow(/整块盘/);
  });
});

describe('inspectFolderTrust', () => {
  it('干净的文件夹：没有要拍板的事', async () => {
    const dir = mkRepo('clean');
    const t = await inspectFolderTrust(dir);
    expect(t.needsDecision).toBe(false);
    expect(t.hooks).toEqual([]);
  });
  it('带 hooks 与 allow 的文件夹：逐条列出、要拍板', async () => {
    const dir = mkRepo('hooked', {
      claudeMd: true,
      settings: {
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] },
        permissions: { allow: ['Bash(rm:*)'], deny: ['WebFetch'] },
      },
    });
    const t = await inspectFolderTrust(dir);
    expect(t.needsDecision).toBe(true);
    expect(t.hooks).toEqual([{ file: 'settings.json', event: 'PreToolUse', matcher: 'Bash', command: 'echo hi' }]);
    expect(t.allow.map(a => a.rule)).toEqual(['Bash(rm:*)']);
    expect(t.deny).toBe(1);
    expect(t.hasClaudeMd).toBe(true);
  });
});

describe('openFolder', () => {
  it('第一次打开：建项目、立 .nodesign/、写身份、排除进 .git/info/exclude；干净的直接算信任', async () => {
    const dir = mkRepo('first');
    const out = await openFolder({ path: dir });
    expect(out.created).toBe(true);
    expect(out.project.folderPath).toBe(dir);
    expect(out.project.folderTrust).toBe(true);
    const identity = JSON.parse(fs.readFileSync(path.join(dir, NODESIGN_DIR, 'project.json'), 'utf8'));
    expect(identity.id).toBe(out.project.id);
    expect(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain('.nodesign/');
    // 用户文件夹的根：除了 .nodesign 一个字不多
    expect(fs.readdirSync(dir).sort()).toEqual(['.git', NODESIGN_DIR, 'src']);
    // 画布根 vs agent 站的地方
    expect(getWorkspaceRoot(out.project.id)).toBe(path.join(dir, NODESIGN_DIR));
    expect(getAgentCwd(out.project.id)).toBe(dir);
    expect(getSessionWorkspace(out.project.id, '00000000-0000-4000-8000-000000000000')).toBe(dir);
    // 家具都在 .nodesign 里
    expect(fs.existsSync(path.join(dir, NODESIGN_DIR, '.claude'))).toBe(true);
    expect(fs.existsSync(path.join(dir, NODESIGN_DIR, '.git'))).toBe(true);
  });

  it('再开同一个文件夹：同一个项目', async () => {
    const dir = mkRepo('again');
    const a = await openFolder({ path: dir });
    const b = await openFolder({ path: dir + path.sep });
    expect(b.created).toBe(false);
    expect(b.project.id).toBe(a.project.id);
  });

  it('文件夹搬家：按 project.json 的 id 接回，索引换路径', async () => {
    const dir = mkRepo('moving');
    const a = await openFolder({ path: dir });
    const moved = path.join(tmp, 'moved-elsewhere');
    fs.renameSync(dir, moved);
    const b = await openFolder({ path: moved });
    expect(b.created).toBe(false);
    expect(b.project.id).toBe(a.project.id);
    expect(getProject(a.project.id).folderPath).toBe(moved);
    expect(getWorkspaceRoot(a.project.id)).toBe(path.join(moved, NODESIGN_DIR));
  });

  it('带 hooks 的文件夹：信任门留给用户（folderTrust 保持 null）', async () => {
    const dir = mkRepo('gated', { settings: { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } } });
    const out = await openFolder({ path: dir });
    expect(out.trust.needsDecision).toBe(true);
    expect(out.project.folderTrust).toBeNull();
  });

  it('拒绝：不存在 / 数据目录 / .nodesign 本身', async () => {
    await expect(openFolder({ path: path.join(tmp, 'nope') })).rejects.toMatchObject({ code: 'FOLDER_NOT_FOUND' });
    await expect(openFolder({ path: process.env.PROJECTS_DATA_DIR })).rejects.toMatchObject({ code: 'FOLDER_IS_DATA_ROOT' });
    const dir = mkRepo('inner');
    await openFolder({ path: dir });
    await expect(openFolder({ path: path.join(dir, NODESIGN_DIR) })).rejects.toMatchObject({ code: 'FOLDER_IS_NODESIGN_DIR' });
  });

  it('不是 git 仓库的文件夹也能开，只是不写 exclude', async () => {
    const dir = mkRepo('plain', { git: false });
    const out = await openFolder({ path: dir });
    expect(out.project.folderPath).toBe(dir);
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(false);
  });
});

describe('桌面在哪（09-08：不分文件夹项目，按首开时空不空）', () => {
  it('空文件夹：桌面就是文件夹本身，身份文件 desk="."，快照为空；.nodesign 排除进 exclude', async () => {
    const dir = path.join(tmp, 'empty-new');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.DS_Store'), '');   // 系统垃圾不算「有东西」
    const out = await openFolder({ path: dir });
    expect(out.desk).toBe('.');
    expect(out.baseline).toEqual([]);
    expect(getWorkspaceRoot(out.project.id)).toBe(dir);
    expect(getAgentCwd(out.project.id)).toBe(dir);
    const identity = JSON.parse(fs.readFileSync(path.join(dir, NODESIGN_DIR, 'project.json'), 'utf8'));
    expect(identity.desk).toBe('.');
    // 跟托管项目 shared/ 同款：根上有 .claude、assets、CLAUDE.md，还 git init 了
    expect(fs.existsSync(path.join(dir, '.claude'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);
    const exclude = fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toMatch(/^\.nodesign\/$/m);
    // 桌面 = 文件夹本身的项目没有仓库卡（没有「外面」可看）
    const { repoSummary } = await import('./repo.js');
    expect(await repoSummary(out.project.id)).toBeNull();
  });

  it('有东西的文件夹：桌面缩进 .nodesign，快照记下首开时根上的条目；后来装满了也不搬家', async () => {
    const dir = mkRepo('has-stuff', { git: false });
    fs.writeFileSync(path.join(dir, 'README.md'), '# x\n');
    const out = await openFolder({ path: dir });
    expect(out.desk).toBe('.nodesign');
    expect(out.baseline.map(e => e.name)).toEqual(['README.md', 'src']);
    expect(getWorkspaceRoot(out.project.id)).toBe(path.join(dir, NODESIGN_DIR));
    // 第二次开：快照不重拍（.nodesign 之外又多了东西也不进快照）
    fs.writeFileSync(path.join(dir, 'later.txt'), 'later\n');
    const again = await openFolder({ path: dir });
    expect(again.baseline.map(e => e.name)).toEqual(['README.md', 'src']);
    expect(again.desk).toBe('.nodesign');
  });

  it('09-07 那批没有 desk 字段的老身份文件：按缩进算', async () => {
    const dir = path.join(tmp, 'legacy-identity');
    fs.mkdirSync(path.join(dir, NODESIGN_DIR), { recursive: true });
    fs.writeFileSync(path.join(dir, NODESIGN_DIR, 'project.json'), JSON.stringify({ id: 'proj_legacy01', createdAt: '2026-09-07T00:00:00.000Z' }));
    const out = await openFolder({ path: dir });
    expect(out.desk).toBe('.nodesign');
    expect(getWorkspaceRoot(out.project.id)).toBe(path.join(dir, NODESIGN_DIR));
  });
});
