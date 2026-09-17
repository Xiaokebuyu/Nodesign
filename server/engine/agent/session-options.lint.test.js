/**
 * 主会话 sdkOptions 的两条 09-13 口径（源码级钉住，session-loop 的 options 在函数里拼，单测装配不起来）：
 *   - 不传 maxTurns（站主定；SDK 0.3.269 实测按每条用户消息计数），也不再读 NODESIGN_MAX_TURNS
 *   - 插件走 pluginDelivery:'initialize'（桌面版 Windows 命令行上限）
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = (f) => readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '');   // 去掉整行注释，只看代码

describe('session-loop sdkOptions', () => {
  const src = code(path.join(here, 'session-loop.js'));
  it('不传 maxTurns、不读 NODESIGN_MAX_TURNS', () => {
    expect(src).not.toMatch(/\bmaxTurns\s*:/);
    expect(src).not.toMatch(/NODESIGN_MAX_TURNS/);
  });
  it('插件清单走 initialize（会话 CLI 与演出进程）', () => {
    expect(src).toMatch(/pluginDelivery:\s*'initialize'/);
    expect(code(path.join(here, '..', 'stage', 'session.js'))).toMatch(/pluginDelivery:\s*'initialize'/);
  });
  it('读围栏与 plugin 写闸的装配（09-17）：additionalDirectories 走 isolation 的同一个函数、带上本项目 tmp；隔离配置拿到已装 plugin；项目级 plugin 根先建好', () => {
    expect(src).toMatch(/additionalDirectories:\s*agentAdditionalDirectories\(\{[^}]*agentTmpDir:\s*agentDirs\.agentTmpDir[^}]*installedPlugins:\s*installed/);
    expect(src).toMatch(/buildIsolationOptions\(\{[^}]*installedPlugins:\s*installed/);
    expect(src).toMatch(/prepareAgentDirs\(\{[^}]*sharedRoot/);
    expect(src).toMatch(/settings:\s*mergeAgentSettings\(isolation\.settings/);
  });
});
