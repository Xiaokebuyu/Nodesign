// 隔离配置与 bwrap 垫片（2026-08-15）
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sandboxShimEnv, buildIsolationOptions, homeReadAllowlist, agentAdditionalDirectories, AGENT_GITCONFIG } from './isolation.js';
import { PLUGIN_ROOT } from './skill.js';
import { platform } from '../../runtime/platform.js';

describe('prepareAgentDirs', () => {
  it('目录真的建出来（bwrap 绑不存在的路径起不来）+ envPatch 三件套', async () => {
    const { prepareAgentDirs } = await import('./isolation.js');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-iso-shared-'));
    const dirs = await prepareAgentDirs({ dataRoot: os.tmpdir(), projectId: 'proj_test_iso', sessionId: 's1', sharedRoot: shared });
    expect(dirs.agentTmpRoot).toBe(path.join(os.tmpdir(), 'nd'));
    expect(dirs.agentTmpDir).toBe(path.join(os.tmpdir(), 'nd', 'proj_test_iso'));
    expect(fs.existsSync(path.join(dirs.agentTmpDir, 'pip'))).toBe(true);
    // 09-17：项目级 plugin 根先建好（沙盒对它 denyWrite，不存在时会在宿主上建占位文件）
    const made = fs.existsSync(path.join(shared, '.claude', 'plugins'));
    fs.rmSync(shared, { recursive: true, force: true });
    expect(made).toBe(true);
    expect(dirs.envPatch).toEqual({
      npm_config_cache: dirs.npmCacheDir,
      CLAUDE_CODE_TMPDIR: dirs.agentTmpDir,
      PIP_CACHE_DIR: path.join(dirs.agentTmpDir, 'pip'),
      // 托管版：git 全局配置换成仓库里那份中性的（家目录遮读后 ~/.gitconfig 读不到）
      ...(platform.fenceOutsideReads ? { GIT_CONFIG_GLOBAL: AGENT_GITCONFIG } : {}),
    });
    // ⚠️ CLAUDE_CODE_TMPDIR 超 ~30 字节时 SDK 静默回退（AF_UNIX 上限）——
    // 生产 os.tmpdir()=/tmp 时必须稳稳在限内
    if (os.tmpdir() === '/tmp') expect(Buffer.byteLength(dirs.agentTmpDir)).toBeLessThanOrEqual(30);
  });
});

describe('沙盒 tmp（2026-08-19，iss_msz25m5p_v5so）', () => {
  const base = { cwdRoot: '/w', sharedRoot: null, npmCacheDir: '/data/.npm-cache', dataRoot: '/data', env: {} };

  it('传了 agentTmpDir：可写可读开天窗，tmp 根整体遮读（跨项目通道）', () => {
    const { sandbox } = buildIsolationOptions({ ...base, agentTmpRoot: '/tmp/nd', agentTmpDir: '/tmp/nd/proj_a' });
    expect(sandbox.filesystem.allowWrite).toContain('/tmp/nd/proj_a');
    expect(sandbox.filesystem.allowRead).toContain('/tmp/nd/proj_a');
    expect(sandbox.filesystem.denyRead).toContain('/tmp/nd');
  });

  it('没传就完全不出现（数组里不能混进 undefined —— bwrap 参数会炸）', () => {
    const { sandbox } = buildIsolationOptions(base);
    for (const list of [sandbox.filesystem.allowWrite, sandbox.filesystem.allowRead, sandbox.filesystem.denyRead]) {
      expect(list.every((p) => typeof p === 'string' && p.length > 0)).toBe(true);
    }
  });
});

describe('bwrap 垫片的 env', () => {
  it('沙盒没开就不插 PATH（垫片只为沙盒服务）', () => {
    if (platform.sandboxEnabled) return;
    expect(sandboxShimEnv({ baseEnv: { PATH: '/usr/bin' } })).toEqual({});
  });
  it('沙盒开着时把垫片目录插在 PATH 最前面，原 PATH 原样跟在后面', () => {
    if (!platform.sandboxEnabled) return;
    const out = sandboxShimEnv({ baseEnv: { PATH: '/usr/bin' }, dataRoot: '/data' });
    expect(out.PATH.startsWith(path.join(platform.repoRoot, 'server', 'ops', 'sandbox-shim')))
      .toBe(true);
    expect(out.PATH.endsWith('/usr/bin')).toBe(true);
    expect(out.NODESIGN_SHIM_LOG).toBe('/data/.sandbox-shim.log');
  });
});

describe('MCP 工具整服务放行（2026-08-25）', () => {
  const base = { cwdRoot: '/w', sharedRoot: null, npmCacheDir: '/data/.npm-cache', dataRoot: '/data', env: {} };

  it('allow 里有整服务规则，且名字跟 mcpServers 的键同源', async () => {
    const { MCP_SERVER_NAME, MCP_ALLOW_RULE } = await import('../mcp/server-name.js');
    const { settings } = buildIsolationOptions(base);
    expect(settings.permissions.allow).toContain(MCP_ALLOW_RULE);
    expect(MCP_ALLOW_RULE).toBe(`mcp__${MCP_SERVER_NAME}`);
    // session-loop 用同一个常量当 mcpServers 的键 —— 谁改名都不会只改一头
    const src = await import('node:fs/promises').then(fs => fs.readFile('server/engine/agent/session-loop.js', 'utf8'));
    expect(src).toContain('[MCP_SERVER_NAME]: nodesignServer');
  });

  it('⛔ Bash 绝不能进 allow —— 它跑任意命令，语义判断正是分类器的本职', () => {
    const { settings } = buildIsolationOptions(base);
    for (const rule of settings.permissions.allow) {
      expect(String(rule).startsWith('Bash')).toBe(false);
    }
  });

  it('deny 没被 allow 挤掉（两节共存，不是互相覆盖）', () => {
    const { settings } = buildIsolationOptions(base);
    expect(Array.isArray(settings.permissions.deny)).toBe(true);
    expect(settings.permissions.deny.length).toBeGreaterThan(0);
  });
});

describe('全站会话转录（09-17）', () => {
  it('Bash 整个遮住 <配置目录>/projects，本会话工作区照常可读', () => {
    const { sandbox } = buildIsolationOptions({ cwdRoot: '/w', sharedRoot: null, npmCacheDir: '/data/.npm-cache', dataRoot: '/data', env: {} });
    expect(sandbox.filesystem.denyRead).toContain(path.join(platform.claudeConfigDir, 'projects'));
    expect(sandbox.filesystem.denyRead).toContain(path.join(platform.claudeConfigDir, 'history.jsonl'));
    expect(sandbox.filesystem.allowRead).toContain('/w');
  });
});

/**
 * 读围栏（09-17，托管版）：Bash 家目录整个遮读 + 白名单开天窗；Read/Grep/Glob 用 CLI 的
 * blockReadsOutsideWorkingDirectories。vitest 跑的是 hosted 形态（没设 NODESIGN_PROFILE）。
 */
describe('读围栏（09-17）', () => {
  const home = path.resolve(os.homedir());
  const covers = (p, t) => p === t || t.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
  const base = { cwdRoot: '/w', sharedRoot: '/w', npmCacheDir: '/data/.npm-cache', agentTmpRoot: '/tmp/nd', agentTmpDir: '/tmp/nd/proj_a', dataRoot: '/data', env: {} };

  it('决策只有一处：托管版开、本地版关', () => {
    expect(platform.isLocal).toBe(false);
    expect(platform.fenceOutsideReads).toBe(!platform.isLocal);
    expect(platform.dump().fenceOutsideReads).toBe(true);
  });

  it('白名单每一条都有来由：仓库、node 目录、playwright 浏览器、CLI 的 shell 快照与会话 env', () => {
    const allow = homeReadAllowlist();
    expect(allow).toContain(platform.repoRoot);
    const nodeDir = path.resolve(path.dirname(process.execPath), '..');
    expect(allow).toContain(covers(nodeDir, home) ? path.dirname(process.execPath) : nodeDir);
    expect(allow).toContain(path.join(home, '.cache', 'ms-playwright'));
    expect(allow).toContain(path.join(platform.claudeConfigDir, 'shell-snapshots'));
    expect(allow).toContain(path.join(platform.claudeConfigDir, 'session-env'));
    // 仓库的 node_modules 是软链时（worktree），真身也开
    const nm = path.join(platform.repoRoot, 'node_modules');
    if (fs.existsSync(nm) && fs.lstatSync(nm).isSymbolicLink()) expect(allow).toContain(fs.realpathSync(nm));
  });

  it('⛔ 白名单里没有通配、没有家目录本身或它的上级、没有配置目录本身', () => {
    for (const p of homeReadAllowlist()) {
      expect(p, p).not.toMatch(/[*?[\]]/);
      expect(covers(p, home), p).toBe(false);
      expect(covers(p, platform.claudeConfigDir), p).toBe(false);
      expect(path.isAbsolute(p)).toBe(true);
    }
  });

  it('⛔ node 直接装在家目录下时（推出来的目录就是家目录）整条丢弃并报错，不许把围栏拆掉', () => {
    const saved = process.execPath;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.execPath = path.join(home, 'node');
      const allow = homeReadAllowlist();
      expect(allow.some((p) => covers(p, home))).toBe(false);
      expect(err.mock.calls.map((c) => c[0]).join('\n')).toMatch(/拒收条目/);
    } finally {
      process.execPath = saved;
      err.mockRestore();
    }
  });

  it('⭐ Bash：家目录与宿主 Claude Code 的 /tmp/claude-<uid> 遮读，白名单进 allowRead，自己的工作区 / tmp / npm 缓存照开', () => {
    const { sandbox } = buildIsolationOptions(base);
    const { denyRead, allowRead } = sandbox.filesystem;
    expect(denyRead).toContain(home);
    expect(denyRead).toContain(`/tmp/claude-${process.getuid()}`);
    for (const p of homeReadAllowlist()) expect(allowRead).toContain(p);
    for (const p of ['/w', '/data/.npm-cache', '/tmp/nd/proj_a']) expect(allowRead).toContain(p);
    // 数据根、别的项目 tmp、全站转录仍在 denyRead（嵌套：家目录遮 → 仓库开 → 数据根再遮 → 工作区再开）
    for (const p of ['/data', '/tmp/nd', path.join(platform.claudeConfigDir, 'projects')]) expect(denyRead).toContain(p);
  });

  it('⛔ /tmp 与 os.tmpdir() 不能整个遮读 —— CLI 的出网代理 socket 在那下面，遮了之后每条命令都出不了网（09-17 实测）', () => {
    const { denyRead } = buildIsolationOptions(base).sandbox.filesystem;
    expect(denyRead).not.toContain('/tmp');
    expect(denyRead).not.toContain(path.resolve(os.tmpdir()));
  });

  it('⭐ Read/Grep/Glob：settings 里带 blockReadsOutsideWorkingDirectories，deny / allow 两节还在', () => {
    const { settings } = buildIsolationOptions(base);
    expect(settings.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(settings.permissions.deny.length).toBeGreaterThan(0);
    expect(settings.permissions.allow.length).toBeGreaterThan(0);
  });

  it('⭐ 本地版（NODESIGN_PROFILE=local）：开关不注入、家目录不遮、白名单不进（子进程里真起一遍 platform）', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-iso-local-'));
    const here = path.dirname(fileURLToPath(import.meta.url));
    const script = `
      const { buildIsolationOptions, prepareAgentDirs } = await import(${JSON.stringify(path.join(here, 'isolation.js'))});
      const { platform } = await import(${JSON.stringify(path.join(here, '../../runtime/platform.js'))});
      const o = buildIsolationOptions({ cwdRoot: '/w', sharedRoot: '/w', npmCacheDir: '/n', dataRoot: '/d', env: {} });
      const d = await prepareAgentDirs({ dataRoot: ${JSON.stringify(dataDir)}, projectId: 'p', sessionId: 's', sharedRoot: ${JSON.stringify(path.join(dataDir, 'ws'))} });
      const fs = await import('node:fs');
      console.log(JSON.stringify({
        isLocal: platform.isLocal, fence: platform.fenceOutsideReads,
        flag: o.settings.permissions.blockReadsOutsideWorkingDirectories ?? null,
        homeDenied: o.sandbox.filesystem.denyRead.includes(${JSON.stringify(home)}),
        repoAllowed: o.sandbox.filesystem.allowRead.includes(${JSON.stringify(platform.repoRoot)}),
        git: d.envPatch.GIT_CONFIG_GLOBAL ?? null,
        pluginRootMade: fs.existsSync(${JSON.stringify(path.join(dataDir, 'ws', '.claude', 'plugins'))}),
      }));`;
    // TMPDIR 指进临时目录：prepareAgentDirs 按 os.tmpdir() 建沙盒 tmp，别在真的 /tmp/nd 下留目录
    const env = { ...process.env, NODESIGN_PROFILE: 'local', NODESIGN_DATA_DIR: dataDir, DB_PATH: path.join(dataDir, 'x.db'), TMPDIR: dataDir };
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 60000 });
    fs.rmSync(dataDir, { recursive: true, force: true });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    expect(out).toEqual({ isLocal: true, fence: false, flag: null, homeDenied: false, repoAllowed: false, git: null, pluginRootMade: false });
  });
});

describe('plugin 目录不许 Bash 写 + additionalDirectories（09-17）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-iso-plug-'));
  const ws = path.join(tmp, 'ws');
  const userPlugin = path.join(tmp, 'users', 'u_a', 'mine');
  for (const d of [path.join(ws, '.claude', 'plugins', 'proj'), path.join(userPlugin, '.claude-plugin'), path.join(userPlugin, 'skills')]) fs.mkdirSync(d, { recursive: true });
  const installedPlugins = { plugins: [{ path: PLUGIN_ROOT }, { path: userPlugin }, { path: path.join(ws, '.claude', 'plugins', 'proj') }], userRoot: path.dirname(userPlugin) };
  const opts = { cwdRoot: ws, sharedRoot: ws, npmCacheDir: '/data/.npm-cache', agentTmpRoot: '/tmp/nd', agentTmpDir: '/tmp/nd/p', dataRoot: '/data', env: {}, installedPlugins };

  it('⭐ denyWrite：项目级 plugin 根整个关、内置 plugin 整个关、用户级只关已存在的 .claude-plugin/ 与 skills/', () => {
    const { denyWrite } = buildIsolationOptions(opts).sandbox.filesystem;
    expect(denyWrite).toContain(path.join(ws, '.claude', 'plugins'));
    expect(denyWrite).toContain(path.join(ws, '.claude', 'agents'));
    expect(denyWrite).toContain(PLUGIN_ROOT);
    expect(denyWrite).toContain(path.join(userPlugin, '.claude-plugin'));
    expect(denyWrite).toContain(path.join(userPlugin, 'skills'));
    // ⛔ 用户级根目录本身不能关（里面没有 .mcp.json，CLI 建占位会失败，每条 Bash 都起不来）
    expect(denyWrite).not.toContain(userPlugin);
    expect(denyWrite).not.toContain(path.dirname(userPlugin));
    expect(denyWrite.every((p) => typeof p === 'string' && p.length > 0)).toBe(true);
  });

  it('⭐ additionalDirectories：工作区、本项目 tmp、内置与用户级 plugin；项目级 plugin 不重复列（它在工作区里）', () => {
    const dirs = agentAdditionalDirectories(opts);
    expect(dirs).toEqual([ws, '/tmp/nd/p', PLUGIN_ROOT, userPlugin]);
  });

  it('⛔ 契约：allowRead 盖住的可写目录（additionalDirectories）里必须已有 .mcp.json，否则 CLI 建占位失败、Bash 全挂', () => {
    const { allowRead, denyWrite } = buildIsolationOptions(opts).sandbox.filesystem;
    const covers = (p, t) => p !== t && t.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
    for (const d of agentAdditionalDirectories(opts)) {
      const covered = allowRead.some((a) => covers(a, d)) || denyWrite.includes(d);
      if (covered) expect(fs.existsSync(path.join(d, '.mcp.json')), `${d} 缺 .mcp.json`).toBe(true);
    }
  });

  it('内置 plugin 常驻的 .mcp.json 不声明任何服务', () => {
    const j = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.mcp.json'), 'utf8'));
    expect(j).toEqual({ mcpServers: {} });
  });

  it('agent-gitconfig 在仓库里、在白名单覆盖范围内、没有凭据助手', () => {
    expect(AGENT_GITCONFIG.startsWith(platform.repoRoot + path.sep)).toBe(true);
    const text = fs.readFileSync(AGENT_GITCONFIG, 'utf8');
    expect(text).toMatch(/\[user\][\s\S]*email = /);
    expect(text).not.toMatch(/credential|helper/i);
  });

  it('清理', () => { fs.rmSync(tmp, { recursive: true, force: true }); });
});
