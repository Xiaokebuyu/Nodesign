/**
 * mode-profile 测试 —— 钉两件事：
 *  1. rp 模式的注册面：下架的真不在、留下的真在（对**真实**注册表断言，不对表自己断言 ——
 *     表自己说自己对不算数）。
 *  2. 对账函数：表里出现注册表没有的名字要当场炸（工具改名后表静默空转是这层最怕的病）。
 */

import { describe, it, expect } from 'vitest';
import { RP_HIDDEN_TOOLS, shouldRegisterForMode, assertModeProfileNames, SKILL_MODES, filterSkillsForMode, assertSkillModeNames } from './mode-profile.js';
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
      'write_on_board', 'edit_board', 'read_board', 'look_at_board', 'read_user_view',
      'cast_role', 'jot_memory', 'read_tavern_json',
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

// ── skill × 模式（2026-08-30）────────────────────────────────────────────
// 判据跟工具那张表同源，但失效方式不同：工具筛错了模型会报「工具不存在」，
// skill 筛错了**什么都不会发生** —— 描述少注一份没人看得见，多注一份也没人看得见。
// 所以这一族断言要钉得比感觉更死一点。
const ALL_SKILLS = Object.keys(SKILL_MODES);

describe('mode-profile —— skill 按模式筛', () => {
  it('设计会话拿不到演出侧的包（那是常驻描述的纯亏）', () => {
    const got = filterSkillsForMode(ALL_SKILLS, 'design');
    expect(got).not.toContain('story-voice');
    expect(got).not.toContain('story-craft');
    expect(got).not.toContain('story-intimacy');
    expect(got).toContain('deskskill-engine-mini');
  });

  it('⭐ 演出会话拿不到设计三件 —— 它们的工具在 RP 下本来就没注册', () => {
    const got = filterSkillsForMode(ALL_SKILLS, 'rp');
    for (const n of ['deskskill-engine-mini', 'docx-craft', 'site-craft']) {
      expect(got, `${n} 的工具在 RP 下已 unregister，描述不该还在`).not.toContain(n);
    }
    expect(got).toContain('story-voice');
  });

  it('both 的两个包两边都在（轻度演故事发生在设计项目里，酒馆卡也常丢进设计项目）', () => {
    for (const mode of ['design', 'rp']) {
      const got = filterSkillsForMode(ALL_SKILLS, mode);
      expect(got, `${mode} 少了 blackboard-rp`).toContain('blackboard-rp');
      expect(got, `${mode} 少了 story-import`).toContain('story-import');
    }
  });

  it('⛔ 表里没有的名字一律放行 —— 用户自己装的 plugin 不归我们裁', () => {
    const mine = ['story-voice', '用户装的-skill', 'someone-elses'];
    expect(filterSkillsForMode(mine, 'design')).toEqual(['用户装的-skill', 'someone-elses']);
    expect(filterSkillsForMode(mine, 'rp')).toEqual(mine);
  });

  it('未知模式落 design（跟工具那张表同口径）', () => {
    expect(filterSkillsForMode(ALL_SKILLS, 'weird')).toEqual(filterSkillsForMode(ALL_SKILLS, 'design'));
  });

  it('对账：表里有没装上的 skill → 当场炸并点名', () => {
    expect(() => assertSkillModeNames(ALL_SKILLS)).not.toThrow();
    expect(() => assertSkillModeNames(ALL_SKILLS.filter(n => n !== 'story-voice'))).toThrow(/story-voice/);
  });
});
