/**
 * 时间线图标表的守卫（09-17，read_user_messages 上线时补）：
 * 服务端 nodesign MCP 每注册一个工具，tool-icons.js 就要有一格，否则用户在时间线上只看到一把扳手，
 * 而且没有任何报错 —— 这张表是手抄的，写死表家族加新成员必漏。
 * 名字从服务端工具源码里扫（跟 server/engine/mcp/tool-concurrency.lint.test.js 同一个判据）。
 * 下面 KNOWN_MISSING 是本守卫落地时已经缺图标的存量，只许删不许加：补上图标就从表里删掉。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_ICONS, getToolIcon } from './tool-icons.js';

const TOOLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../server/engine/mcp/tools');

/** 09-17 落地时的存量缺口（演出线、进程卡、状态表那几件） */
const KNOWN_MISSING = new Set([
  'cast_role', 'draw_trend', 'open_stage', 'start_process', 'read_process_log', 'stop_process',
  'list_processes', 'jot_memory', 'roll_dice', 'set_vars', 'stage_backdrop', 'stage_status',
]);

function serverToolNames() {
  const names = new Set();
  for (const f of readdirSync(TOOLS_DIR)) {
    if (!f.endsWith('.js') || f.includes('.test.')) continue;
    const s = readFileSync(path.join(TOOLS_DIR, f), 'utf8');
    for (const m of s.matchAll(/\btool\(\s*'([a-z_]+)'/g)) names.add(m[1]);
    for (const m of s.matchAll(/\bname:\s*'([a-z]+_batch)'/g)) names.add(m[1]);
  }
  return names;
}

describe('tool-icons 覆盖服务端工具', () => {
  it('每个 nodesign 工具都有图标（存量缺口除外）', () => {
    const names = serverToolNames();
    // 判据自检：真扫到了东西，且批工具与 09-17 新件都在
    expect(names.has('write_on_board')).toBe(true);
    expect(names.has('browser_batch')).toBe(true);
    expect(names.has('read_user_messages')).toBe(true);
    const missing = [...names].filter((n) => !TOOL_ICONS[`mcp__nodesign__${n}`] && !KNOWN_MISSING.has(n)).sort();
    expect(missing, '新工具要在 tool-icons.js 登记图标').toEqual([]);
  });

  it('存量缺口表只许缩：表里的名字仍是真工具、且确实还没有图标', () => {
    const names = serverToolNames();
    expect([...KNOWN_MISSING].filter((n) => !names.has(n)), '工具已删，从 KNOWN_MISSING 里去掉').toEqual([]);
    expect([...KNOWN_MISSING].filter((n) => TOOL_ICONS[`mcp__nodesign__${n}`]), '已补图标，从 KNOWN_MISSING 里去掉').toEqual([]);
  });

  it('read_user_messages 不落到默认扳手', () => {
    expect(getToolIcon('mcp__nodesign__read_user_messages')).not.toBe(getToolIcon('mcp__nodesign__no_such_tool'));
  });
});
