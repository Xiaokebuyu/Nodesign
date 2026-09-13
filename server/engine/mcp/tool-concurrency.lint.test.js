/**
 * 并行只读表的守卫（2026-09-13）。三条：
 *   1. 覆盖：tools/ 里注册的每个工具名都在并行表或串行表里，表里也没有源码里不存在的名字。
 *      新工具不许默认落在「没想过」这一格 —— 写死表家族加新成员必漏（[[nodesign-kinds-architecture]] 那一族）。
 *   2. 判据：会自起 chromium 的工具（capability-gate 表里挂 chromium 位的，那张表有自己的 lint 保证完整）
 *      进并行表必须在 GATED 里点名，并且源码里真有串行闸。
 *   3. 装配：真装一台 server，打了 readOnlyHint 的恰好是并行表里注册上的那些，没有漏打、没有多打。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARALLEL_READ_TOOLS, SERIAL_TOOLS, assertConcurrencyNames } from './tool-concurrency.js';
import { TOOL_CAPABILITIES } from './capability-gate.js';
import { createNodesignMcpServer } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const toolsDir = path.join(here, 'tools');
const TOOL_NAME = /\btool\(\s*'([a-z_]+)'/g;
const BATCH_NAME = /\bname:\s*'([a-z]+_batch)'/g;

/** 自起 chromium 却能进并行表的：工具名 → [源码文件, 证明有串行闸的正则] */
const GATED = {
  look_at_board: ['look-at-board.js', /const withGate = \(fn\) => \{ const run = gate\.then\(fn, fn\)/],
};

function sourceToolNames() {
  const names = new Set();
  for (const f of readdirSync(toolsDir)) {
    if (!f.endsWith('.js') || f.includes('.test.')) continue;
    const s = readFileSync(path.join(toolsDir, f), 'utf8');
    for (const m of s.matchAll(TOOL_NAME)) names.add(m[1]);
    for (const m of s.matchAll(BATCH_NAME)) names.add(m[1]);
  }
  return names;
}

describe('tool-concurrency 并行只读表', () => {
  it('每个工具都登记了并行或串行，表里没有幽灵名字，两表不相交', () => {
    const names = sourceToolNames();
    // 判据自检：扫描真扫到了东西（批工具走的是 name: 字段，不是 tool('…')）
    expect(names.has('write_on_board')).toBe(true);
    expect(names.has('browser_batch')).toBe(true);
    const unregistered = [...names].filter((n) => !PARALLEL_READ_TOOLS.has(n) && !SERIAL_TOOLS.has(n)).sort();
    expect(unregistered, '新工具要在 tool-concurrency.js 登记是并行只读还是串行').toEqual([]);
    const ghosts = [...PARALLEL_READ_TOOLS, ...SERIAL_TOOLS].filter((n) => !names.has(n)).sort();
    expect(ghosts, '表里的名字在源码里找不到（改名或删工具后表没跟上）').toEqual([]);
    expect([...PARALLEL_READ_TOOLS].filter((n) => SERIAL_TOOLS.has(n))).toEqual([]);
  });

  it('自起 chromium 的工具进并行表必须有串行闸', () => {
    const offenders = [...PARALLEL_READ_TOOLS]
      .filter((n) => TOOL_CAPABILITIES[n]?.cap === 'chromium' && !GATED[n]);
    expect(offenders, '并行 = 同时拉起多只 chromium；要么挪到串行表，要么先加串行闸再登记进 GATED').toEqual([]);
    for (const [name, [file, proof]] of Object.entries(GATED)) {
      expect(PARALLEL_READ_TOOLS.has(name)).toBe(true);
      expect(readFileSync(path.join(toolsDir, file), 'utf8'), `${name} 的串行闸不见了`).toMatch(proof);
    }
    // 判据自检：capability 表确实把 look_at_board 当 chromium 工具（否则上面那条恒真）
    expect(TOOL_CAPABILITIES.look_at_board?.cap).toBe('chromium');
  });

  it('装配出来的 server：打了 readOnlyHint 的恰好是并行表里注册上的那些', () => {
    for (const mode of ['design', 'rp']) {
      const server = createNodesignMcpServer({
        workspaceRoot: '/tmp', sharedRoot: '/tmp',
        projectId: 'proj_test_concurrency0', sessionId: 'sess-concurrency-test', projectMode: mode,
      });
      const registered = new Set(server.toolNames);
      const expected = [...PARALLEL_READ_TOOLS].filter((n) => registered.has(n)).sort();
      expect([...server.readOnlyToolNames].sort()).toEqual(expected);
      // 判据自检：至少板面两件在任何模式下都注册着，名单不会因为全被下架而空着"过"
      expect(expected).toEqual(expect.arrayContaining(['read_board', 'look_at_board']));
    }
  });

  it('启动期对账：并行表里出现注册表没有的名字就炸', () => {
    expect(() => assertConcurrencyNames(['read_board'])).toThrow(/静默串行/);
    expect(() => assertConcurrencyNames([...PARALLEL_READ_TOOLS])).not.toThrow();
  });
});
