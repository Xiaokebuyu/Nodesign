// plugin 加载时的组件校验（09-17）
//
// 为什么要在加载时再判一遍：项目级 plugin 根在 agent 的工作区里，09-17 以前 Write 与 Bash 都写得进去；
// 写进去的 hooks / skill frontmatter 里的 hooks 在下个会话由 CLI 宿主进程在沙盒外执行（SDK 探针实测）。
// 上传口的组件白名单管不到这条路，所以加载时用同一张表逐个判，不合规整个跳过。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-ploader-'));
const dataDir = path.join(tmp, 'projects-data');
const userBase = path.join(tmp, 'user-plugins');
let loader;
let issues;

const md = (name, extra = '') => `---\nname: ${name}\ndescription: 测试\n${extra}---\n# ${name}\n`;
function mkPlugin(dir, { manifest = {}, files = {} } = {}) {
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: path.basename(dir), version: '0.1.0', description: 'x', ...manifest }));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}
const skill = (n) => ({ [`skills/${n}/SKILL.md`]: md(n) });

beforeAll(async () => {
  vi.stubEnv('PROJECTS_DATA_DIR', dataDir);
  vi.stubEnv('NODESIGN_USER_PLUGINS_DIR', userBase);
  loader = await import('./plugin-loader.js');
  issues = await import('../../lib/issues-store.js');
});
afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('pluginLoadViolations', () => {
  const v = async (dir) => loader.pluginLoadViolations(dir, JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8')));
  const P = (name) => path.join(tmp, 'v', name);

  it('正门装出来的形状（清单 + skills 下文本图片 + 市场来源记录）→ 零违规', async () => {
    const d = mkPlugin(P('clean'), { files: { ...skill('a'), 'skills/a/ref.md': 'x', 'skills/a/pic.png': 'x', '.claude-plugin/nodesign-origin.json': '{}' } });
    expect(await v(d)).toEqual([]);
  });

  it('⭐ hooks / agents / commands / bin / 非空 .mcp.json / .lsp.json / settings.json → 全部点名', async () => {
    const d = mkPlugin(P('evil'), { files: {
      ...skill('e'), 'hooks/hooks.json': '{}', 'agents/x.md': 'x', 'commands/c.md': 'x', 'bin/run': 'x',
      '.mcp.json': '{"mcpServers":{"x":{}}}', '.lsp.json': '{}', 'settings.json': '{}',
    } });
    const bad = await v(d);
    for (const f of ['hooks/hooks.json', 'agents/x.md', 'commands/c.md', 'bin/run', '.mcp.json', '.lsp.json', 'settings.json']) expect(bad).toContain(f);
  });

  it('根目录下的空 .mcp.json 是 CLI 在别的会话跑 Bash 时建的临时占位 → 放行', async () => {
    const d = mkPlugin(P('stub'), { files: { ...skill('s'), '.mcp.json': '' } });
    expect(await v(d)).toEqual([]);
  });

  it('⭐ 清单里声明组件（hooks / mcpServers / agents / commands / skills 自定义路径）→ 违规；纯元数据字段放行', async () => {
    const d = mkPlugin(P('mani'), { manifest: { hooks: './x.json', mcpServers: {}, agents: [], commands: [], skills: './elsewhere', author: { name: 'a' }, keywords: ['k'] }, files: skill('m') });
    const bad = await v(d);
    for (const k of ['hooks', 'mcpServers', 'agents', 'commands', 'skills']) expect(bad).toContain(`.claude-plugin/plugin.json#${k}`);
    expect(bad.some((b) => /#(author|keywords)$/.test(b))).toBe(false);
  });

  it('⭐ SKILL.md 的 frontmatter 带 hooks（单行 flow 写法）/ allowed-tools → 违规', async () => {
    const d = mkPlugin(P('fm'), { files: {
      'skills/a/SKILL.md': md('a', 'hooks: {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "id"}]}]}\n'),
      'skills/b/SKILL.md': md('b', 'allowed-tools: Bash\n'),
      'skills/c/skill.md': md('c', 'hooks: {}\n'),
    } });
    const bad = await v(d);
    expect(bad.some((b) => b.startsWith('skills/a/SKILL.md') && /hooks/.test(b))).toBe(true);
    expect(bad.some((b) => b.startsWith('skills/b/SKILL.md') && /allowed-tools/.test(b))).toBe(true);
    expect(bad.some((b) => b.startsWith('skills/c/skill.md'))).toBe(true);   // 大小写不敏感的文件系统上它就是 SKILL.md
  });

  it('软链一律不许（能把组件名指到别处）', async () => {
    const d = mkPlugin(P('link'), { files: skill('l') });
    fs.mkdirSync(path.join(tmp, 'elsewhere-hooks'), { recursive: true });
    fs.symlinkSync(path.join(tmp, 'elsewhere-hooks'), path.join(d, 'skills', 'l', 'assets'));
    expect((await v(d)).some((b) => /软链/.test(b))).toBe(true);
  });

  it('文件树超过上限 → 当不合规（开局扫描不能被一棵大树拖住）', async () => {
    const files = {};
    for (let i = 0; i <= loader.PLUGIN_TREE_MAX_ENTRIES; i++) files[`skills/big/f${i}.md`] = 'x';
    const d = mkPlugin(P('big'), { files: { ...skill('big'), ...files } });
    expect((await v(d)).some((b) => /超过/.test(b))).toBe(true);
  });
});

describe('loadInstalledPlugins：用户级与项目级不合规的整个跳过，内置照常', () => {
  const pid = 'proj_ploader_t1';
  const uid = 'u_ploader';

  it('⭐ 带 hooks 的项目级 plugin 与带 frontmatter hooks 的用户级 plugin 被跳过并记问题库，干净的照常加载', async () => {
    const projRoot = path.join(dataDir, pid, 'shared', '.claude', 'plugins');
    mkPlugin(path.join(projRoot, 'evil'), { files: { ...skill('evil-skill'), 'hooks/hooks.json': '{"hooks":{}}' } });
    mkPlugin(path.join(projRoot, 'clean'), { files: skill('clean-skill') });
    const userRoot = path.join(userBase, uid);
    mkPlugin(path.join(userRoot, 'fmhook'), { files: { 'skills/fmhook/SKILL.md': md('fm-hook', 'hooks: {}\n') } });
    mkPlugin(path.join(userRoot, 'mine'), { files: skill('mine-skill') });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await loader.loadInstalledPlugins({ projectId: pid, userId: uid });
    const logged = err.mock.calls.map((c) => c[0]).join('\n');
    err.mockRestore();

    const names = out.plugins.map((p) => path.basename(p.path)).sort();
    expect(names).toEqual(['clean', 'mine', 'nodesign']);
    expect(out.skills).toContain('clean-skill');
    expect(out.skills).toContain('mine-skill');
    expect(out.skills).not.toContain('evil-skill');
    expect(out.skills).not.toContain('fm-hook');
    expect(out.diagnostics).toEqual({ builtin: 1, user: 1, project: 1 });
    expect(out.userRoot).toBe(userRoot);
    expect(logged).toMatch(/project\/evil.*hooks\/hooks\.json/);
    expect(logged).toMatch(/user\/fmhook.*SKILL\.md/);

    const rows = issues.listIssues({ source: 'auto' }).filter((r) => r.toolName === 'plugin_loader');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const text = JSON.stringify(rows);
    expect(text).toMatch(/evil/);
    expect(text).toMatch(/fmhook/);
    expect(rows.every((r) => r.kind === 'bug')).toBe(true);
  });

  it('内置 plugin 不走校验（它在仓库里，写保护在隔离配置那边）', async () => {
    const out = await loader.loadInstalledPlugins({});
    expect(out.plugins.map((p) => p.path)).toContain((await import('./skill.js')).PLUGIN_ROOT);
    expect(out.userRoot).toBeNull();
  });
});
