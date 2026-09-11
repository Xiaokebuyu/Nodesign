// agent 子进程继承的环境（09-11）：服务器运行姿态、宿主 Claude Code 会话的身份变量都不许漏进去
import { describe, it, expect } from 'vitest';
import { agentInheritedEnv, HOST_SESSION_ENV_KEYS } from './agent-env.js';

describe('agentInheritedEnv', () => {
  const host = Object.fromEntries(HOST_SESSION_ENV_KEYS.map((k) => [k, 'leaked']));
  const env = { PATH: '/usr/bin', HOME: '/home/x', NODE_ENV: 'production', OLDPWD: '/srv', npm_config_omit: 'dev',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000', ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5', ...host,
    VSCODE_GIT_IPC_AUTH_TOKEN: 'leaked', VSCODE_IPC_HOOK_CLI: '/run/x.sock', CURSOR_LAYOUT: 'x' };
  const out = agentInheritedEnv(env);

  it('宿主会话的身份 / 运行时变量一个不留（SDK 只在 ENTRYPOINT / SDK_VERSION 没设时才填自己的值）', () => {
    for (const k of HOST_SESSION_ENV_KEYS) expect(out).not.toHaveProperty(k);
    expect(HOST_SESSION_ENV_KEYS).toEqual(expect.arrayContaining(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_MESSAGING_TOKEN']));
  });
  it('编辑器宿主（Cursor / VS Code 远程）的变量按前缀整族剔掉', () => {
    for (const k of ['VSCODE_GIT_IPC_AUTH_TOKEN', 'VSCODE_IPC_HOOK_CLI', 'CURSOR_LAYOUT', 'ELECTRON_RUN_AS_NODE', 'GIT_ASKPASS']) expect(out).not.toHaveProperty(k);
  });
  it('服务器运行姿态照旧剔掉（08-24 案：NODE_ENV=production 让 agent 的 npm install 跳过 devDependencies）', () => {
    for (const k of ['NODE_ENV', 'OLDPWD', 'npm_config_omit']) expect(out).not.toHaveProperty(k);
  });
  it('其余原样留：PATH / HOME、用户有意配的 CLAUDE_CODE_* 设置、订阅路有意可覆盖的 ANTHROPIC_SMALL_FAST_MODEL', () => {
    expect(out).toMatchObject({ PATH: '/usr/bin', HOME: '/home/x', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000', ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5' });
  });
  it('不改入参', () => { expect(env.NODE_ENV).toBe('production'); expect(env.CLAUDECODE).toBe('leaked'); });
});
