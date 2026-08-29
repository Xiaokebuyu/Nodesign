// 板上署名这条链（2026-08-26 RP 常驻角色线）
//
// 链是：PreToolUse 盖章（agent_id/agent_type + toolUseId）→ actor-trail 记下
// → MCP handler 用 extra 里的 toolUseId 查回来 → 落盘成 `by` → 读侧按视角渲染。
//
// 为什么整条链要一起测：每一环单独看都对，接错一环的症状是「所有板书都署主 agent 的名」，
// 不报错、看着也正常 —— 只有把 hook 的输出真喂进工具的入口才验得出来。
import { describe, it, expect, beforeEach } from 'vitest';
import { makePreToolUseActorStamp } from '../agent/hooks/pre-defaults.js';
import { _resetActorTrail } from '../agent/actor-trail.js';
import { byOf, toolUseIdOf, describeBy, roleLabel } from './actor.js';
import { normalizeBy } from '../../lib/chalk.js';

const extraFor = (id) => ({ _meta: { 'claudecode/toolUseId': id } });
const stamp = makePreToolUseActorStamp();

beforeEach(() => _resetActorTrail());

describe('盖章 → 查表', () => {
  it('⭐ 角色调的板上工具，署名是它的 slug', async () => {
    await stamp({ agent_id: 'a123', agent_type: 'rp-moli' }, 'toolu_1');
    expect(byOf(extraFor('toolu_1'))).toBe('rp-moli');
  });

  it('主 agent 调的（hook 里没有 agent_id/agent_type）→ agent', async () => {
    await stamp({}, 'toolu_2');
    expect(byOf(extraFor('toolu_2'))).toBe('agent');
  });

  it('普通干活子代理（不是常驻角色）→ 仍算 agent，不署 vision-checker 的名', async () => {
    await stamp({ agent_id: 'a9', agent_type: 'vision-checker' }, 'toolu_3');
    expect(byOf(extraFor('toolu_3'))).toBe('agent');
  });

  it('查不到章 → agent（淘汰/漏挂时的兜底是"算主 agent"，不是崩）', () => {
    expect(byOf(extraFor('toolu_unknown'))).toBe('agent');
    expect(byOf(undefined)).toBe('agent');
    expect(byOf({})).toBe('agent');
  });

  it('toolUseId 就在 extra._meta 那个键上（2026-08-26 实测形状）', () => {
    expect(toolUseIdOf(extraFor('toolu_x'))).toBe('toolu_x');
    expect(toolUseIdOf({ _meta: {} })).toBeNull();
  });

  it('⚠️ 两次调用互不串台（同一角色连写两条板书也各查各的）', async () => {
    await stamp({ agent_type: 'rp-a' }, 'toolu_a');
    await stamp({ agent_type: 'rp-b' }, 'toolu_b');
    expect(byOf(extraFor('toolu_a'))).toBe('rp-a');
    expect(byOf(extraFor('toolu_b'))).toBe('rp-b');
  });
});

describe('落盘的 by 收成三类白名单', () => {
  it('user / agent / rp-slug 三类原样，其余落回 agent', () => {
    expect(normalizeBy('user')).toBe('user');
    expect(normalizeBy('rp-moli')).toBe('rp-moli');
    expect(normalizeBy('agent')).toBe('agent');
    expect(normalizeBy('')).toBe('agent');
    expect(normalizeBy(undefined)).toBe('agent');
  });
  it('⭐ 认不出的字符串不许原样进（by 有好几个读者，而写它的是模型）', () => {
    for (const bad of ['<script>', 'rp-', 'RP-moli', '用户', 'rp-a b', 'rp-墨璃']) {
      expect(normalizeBy(bad)).toBe('agent');
    }
  });
});

describe('读侧按视角渲染 —— 同一句「你写的」对两个读者含义相反', () => {
  const names = new Map([['rp-moli', '墨璃']]);
  it('角色读自己写的 → 你；读主控写的 → 主控；读用户写的 → 用户', () => {
    expect(describeBy('rp-moli', 'rp-moli', names)).toBe('你');
    expect(describeBy('agent', 'rp-moli', names)).toBe('主控');
    expect(describeBy('user', 'rp-moli', names)).toBe('用户');
  });
  it('主控读角色写的 → 角色的展示名', () => {
    expect(describeBy('rp-moli', 'agent', names)).toBe('墨璃');
  });
  it('⭐ 展示名查不到就显示 slug —— 宁可难看，也不能把角色写的说成别人写的', () => {
    expect(describeBy('rp-ghost', 'agent', names)).toBe('rp-ghost');
    expect(describeBy('rp-ghost', 'agent', undefined)).toBe('rp-ghost');
  });
});

describe('保留字设防 —— 展示名取自角色自己写的文件', () => {
  it('⭐ 角色自称「用户」/「主控」时退回 slug（不然渲染出来跟真身逐字相同）', () => {
    for (const fake of ['用户', '主控', '你', 'user', 'agent', 'main', '系统', '我', '管理员', 'assistant', 'Claude', 'human', 'admin', 'root', '主人', '助手']) {
      expect(roleLabel('rp-fake', fake)).toBe('rp-fake');
    }
  });

  it('⭐⭐ 三种真实绕法（08-26 复审实测）：大小写 / 零宽空格 / 西里尔同形字', () => {
    expect(roleLabel('rp-fake', 'User')).toBe('rp-fake');
    expect(roleLabel('rp-fake', 'USER')).toBe('rp-fake');
    expect(roleLabel('rp-fake', 'Agent')).toBe('rp-fake');
    expect(roleLabel('rp-fake', '用\u200b户')).toBe('rp-fake');       // 零宽空格，肉眼同形
    expect(roleLabel('rp-fake', '\u200buser')).toBe('rp-fake');
  });

  it('渲染出去的名字不许藏不可见字符', () => {
    expect(roleLabel('rp-moli', '墨\u200b璃')).toBe('墨璃');
  });
  it('正常名字照用', () => {
    expect(roleLabel('rp-moli', '墨璃')).toBe('墨璃');
  });
  it('空名字退回 slug', () => {
    expect(roleLabel('rp-moli', '')).toBe('rp-moli');
    expect(roleLabel('rp-moli', null)).toBe('rp-moli');
  });
  it('describeBy 走的是同一道防线', () => {
    expect(describeBy('rp-fake', 'agent', new Map([['rp-fake', '用户']]))).toBe('rp-fake');
  });
});
