// 隔离配置与 bwrap 垫片（2026-08-15）
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { sandboxShimEnv, buildIsolationOptions } from './isolation.js';
import { platform } from '../../runtime/platform.js';

describe('prepareAgentDirs', () => {
  it('目录真的建出来（bwrap 绑不存在的路径起不来）+ envPatch 三件套', async () => {
    const { prepareAgentDirs } = await import('./isolation.js');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const dirs = await prepareAgentDirs({ dataRoot: os.tmpdir(), projectId: 'proj_test_iso', sessionId: 's1' });
    expect(dirs.agentTmpRoot).toBe(path.join(os.tmpdir(), 'nd'));
    expect(dirs.agentTmpDir).toBe(path.join(os.tmpdir(), 'nd', 'proj_test_iso'));
    expect(fs.existsSync(path.join(dirs.agentTmpDir, 'pip'))).toBe(true);
    expect(dirs.envPatch).toEqual({
      npm_config_cache: dirs.npmCacheDir,
      CLAUDE_CODE_TMPDIR: dirs.agentTmpDir,
      PIP_CACHE_DIR: path.join(dirs.agentTmpDir, 'pip'),
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
