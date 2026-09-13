/**
 * 检索关键词表的守卫（2026-09-13）：
 *   1. 表里每个名字都是真工具，而且不在常驻表里（常驻工具的 schema 本来就在上下文，hint 白写）
 *   2. 只许 ASCII 小写词（09-13 探针：ToolSearch 分词不认中文，「抠图」搜不到）
 *   3. 装配出来的 server 真把 hint 挂上了（不是只有表）
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_SEARCH_HINTS } from './tool-search-hints.js';
import { ALWAYS_LOAD_TOOLS, createNodesignMcpServer } from './index.js';

const toolsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tools');
function sourceToolNames() {
  const names = new Set();
  for (const f of readdirSync(toolsDir)) {
    if (!f.endsWith('.js') || f.includes('.test.')) continue;
    for (const m of readFileSync(path.join(toolsDir, f), 'utf8').matchAll(/\btool\(\s*'([a-z_]+)'/g)) names.add(m[1]);
  }
  return names;
}

describe('TOOL_SEARCH_HINTS', () => {
  it('名字都是真工具、且都是延迟加载的', () => {
    const names = sourceToolNames();
    expect(names.has('generate_image')).toBe(true);   // 判据自检
    expect(Object.keys(TOOL_SEARCH_HINTS).filter((n) => !names.has(n))).toEqual([]);
    expect(Object.keys(TOOL_SEARCH_HINTS).filter((n) => ALWAYS_LOAD_TOOLS.has(n))).toEqual([]);
  });

  it('只许 ASCII 小写词（ToolSearch 分词不认中文）', () => {
    const bad = Object.entries(TOOL_SEARCH_HINTS).filter(([, h]) => !/^[a-z0-9]+( [a-z0-9]+)*$/.test(h)).map(([n]) => n);
    expect(bad).toEqual([]);
  });

  it('装配出来的 server 挂上了 hint', () => {
    const server = createNodesignMcpServer({ workspaceRoot: '/tmp', sharedRoot: '/tmp', projectId: 'proj_test_hints0', sessionId: 'sess-hints', projectMode: 'design' });
    const registered = new Set(server.toolNames);
    const expected = Object.keys(TOOL_SEARCH_HINTS).filter((n) => registered.has(n)).sort();
    expect(expected.length).toBeGreaterThan(5);   // 判据自检：别因为全被下架而空着过
    expect([...server.searchHintToolNames].sort()).toEqual(expected);
  });
});
