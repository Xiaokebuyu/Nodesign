/**
 * mode-profile 测试 —— 钉两件事：
 *  1. rp 模式的注册面：下架的真不在、留下的真在（对**真实**注册表断言，不对表自己断言 ——
 *     表自己说自己对不算数）。
 *  2. 对账函数：表里出现注册表没有的名字要当场炸（工具改名后表静默空转是这层最怕的病）。
 */

import { describe, it, expect } from 'vitest';
import { RP_HIDDEN_TOOLS, shouldRegisterForMode, assertModeProfileNames } from './mode-profile.js';
import { createNodesignMcpServer } from './index.js';

const mk = (mode) => createNodesignMcpServer({
  workspaceRoot: '/tmp', sharedRoot: '/tmp',
  projectId: 'proj_test_mode0', sessionId: 'sess-mode-test', projectMode: mode,
}).toolNames;

describe('mode-profile —— rp 模式的注册面', () => {
  it('design 是全量，rp 是真子集，差集恰好是下架表', () => {
    const design = new Set(mk('design'));
    const rp = new Set(mk('rp'));
    // 下架的一个都不许漏进 rp
    for (const n of RP_HIDDEN_TOOLS) {
      expect(rp.has(n), `rp 模式漏了没藏住：${n}`).toBe(false);
    }
    // rp 里的每一件 design 里都有，且 design 多出来的恰好是下架表
    for (const n of rp) expect(design.has(n), `rp 有而 design 没有：${n}`).toBe(true);
    const diff = [...design].filter((n) => !rp.has(n)).sort();
    expect(diff).toEqual([...RP_HIDDEN_TOOLS].filter((n) => design.has(n)).sort());
  });

  it('rp 模式留下的家底：黑板 / 角色 / 生图 / 浏览器 / DirectEdit 收口', () => {
    const rp = new Set(mk('rp'));
    for (const n of [
      'write_on_board', 'edit_board', 'read_board', 'board_batch', 'look_at_board', 'read_user_view',
      'cast_role', 'await_user', 'check_inbox', 'read_tavern_json',
      'generate_image', 'remove_background', 'lookup_tags',
      'browser_navigate', 'browser_batch', 'screenshot_url', 'web_search',
      'get_pending_changes', 'clear_pending_changes',   // DirectEdit 是用户输入通道，不是设计产线
      'navigate_to_page', 'highlight', 'deliver_files', 'report_issue',
    ]) {
      expect(rp.has(n), `rp 模式不该藏：${n}`).toBe(true);
    }
  });

  it('shouldRegisterForMode：design / 未知模式一律放行', () => {
    const t = { name: 'build_docx' };
    expect(shouldRegisterForMode(t, 'design')).toBe(true);
    expect(shouldRegisterForMode(t, undefined)).toBe(true);
    expect(shouldRegisterForMode(t, 'rp')).toBe(false);
  });
});

describe('mode-profile —— 对账', () => {
  it('表里的名字全在注册表里时通过', () => {
    expect(() => assertModeProfileNames(mk('design'))).not.toThrow();
  });

  it('表里出现注册表没有的名字 → 当场炸并点名', () => {
    const names = mk('design').filter((n) => n !== 'build_docx');
    expect(() => assertModeProfileNames(names)).toThrow(/build_docx/);
  });
});
