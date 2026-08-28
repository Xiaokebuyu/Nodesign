// 常驻角色这条链的回归闸（2026-08-26 建；2026-08-28 演员位重构改版）
//
// 为什么是「一条链一个测试文件」而不是按源文件切：这条链的正确性不在任何单个
// 函数里，而在**判据、名册、若干 handler 的联动**上 —— H1 那个洞就是判据本身
// 写对了、闸也调对了，但判据问错了问题（问"名字像不像"而不是"本会话有没有"）。
//
// 08-28 改版随演员位重构：castedInRun 回合闸整族退役（预注册演员位没有"本回合刚造
// 派不动"这个状态）；新增 name 闸 / agentId 别名 / 退场解析三族断言。
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isResidentRole, isSlotType, createRoleRoster, slotAgentFile, SLOT_TYPES } from '../cast.js';
import { normalizeBy } from '../../../lib/chalk.js';
import { sanitizeObject } from '../../../projects/board-sanitize.js';
import { noteAgentName, agentNameOf, _resetActorTrail } from '../actor-trail.js';
import { makePostToolUseSlotAliasHandler } from './slot-alias.js';

/** 借 sanitizeObject 探一个 by 值落不落得下来（board-sanitize 是 by 的读者之一） */
const sanitizeObjectBy = (by) => sanitizeObject({ x: 0, y: 0, by })?.by;
import { makePreToolUseAgentForceForegroundHandler } from './pre-defaults.js';
import { makePreToolUseSendMessageRecipientGuard } from './pre-peer-guard.js';
import { makePostToolUseFailureRoleRelease, makeSubagentStopRoleNotice } from './resident-role-lifecycle.js';

const upd = async (h, tool_input) => (await h({ tool_input }))?.hookSpecificOutput?.updatedInput ?? null;
const decision = async (h, tool_input) => (await h({ tool_input }))?.hookSpecificOutput?.permissionDecision ?? 'allow';

// 演员位派发要过 illegalRoleTools（读演员位文件的 tools 行）——夹具用**真的**
// slotAgentFile 落盘，验的同时也是"harness 自己写的演员位过得了自己的闸"。
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-resident-test-'));
fs.mkdirSync(path.join(WS, '.claude', 'agents'), { recursive: true });
for (const slot of Object.keys(SLOT_TYPES)) {
  fs.writeFileSync(path.join(WS, '.claude', 'agents', `${slot}.md`), slotAgentFile(slot, 'nodesign'));
}

describe('判据：谁算常驻角色', () => {
  it('rp- 前缀 + 合法 ASCII slug 才算', () => {
    expect(isResidentRole('rp-narrator')).toBe(true);
    expect(isResidentRole('rp-mo_li-2')).toBe(true);
  });
  it('⭐ 坏名字一个都不能认 —— 它会被拿去拼文件路径和当收件人名', () => {
    for (const bad of ['rp-', 'rp-墨璃', 'rp-a/../b', 'rp-a b', 'narrator', '', null, undefined, 42]) {
      expect(isResidentRole(bad)).toBe(false);
    }
  });
  it('⭐⭐ 判据只有一份：rp- 之后的首字符必须是字母数字', () => {
    expect(isResidentRole('rp--x')).toBe(false);
    expect(isResidentRole('rp-_x')).toBe(false);
    expect(normalizeBy('rp--x')).toBe('agent');
    expect(sanitizeObjectBy('rp--x')).toBeUndefined();
  });
  it('64 字符上限跟 CLI 的收件人名校验对齐', () => {
    expect(isResidentRole('rp-' + 'a'.repeat(61))).toBe(true);    // 共 64
    expect(isResidentRole('rp-' + 'a'.repeat(62))).toBe(false);   // 65 → CLI 会拒
  });
  it('演员位是常驻角色判据的子集，但 isSlotType 单独认（位置不是人）', () => {
    expect(isResidentRole('rp-actor')).toBe(true);
    expect(isSlotType('rp-actor')).toBe(true);
    expect(isSlotType('rp-narrator')).toBe(true);
    expect(isSlotType('rp-cheng-wan')).toBe(false);
    expect(isSlotType(null)).toBe(false);
  });
});

describe('前台/后台：普通子代理的老行为不许变', () => {
  const h = makePreToolUseAgentForceForegroundHandler({ roster: createRoleRoster() });
  it('不传 run_in_background → 补成前台（2026-08-03 那次报告拿不回来的事故）', async () => {
    expect((await upd(h, { subagent_type: 'worker' }))?.run_in_background).toBe(false);
  });
  it('已显式前台 → 不重复改', async () => {
    expect(await h({ tool_input: { subagent_type: 'worker', run_in_background: false } })).toEqual({});
  });
  it('显式后台的普通子代理也被拉回前台', async () => {
    expect((await upd(h, { subagent_type: 'worker', run_in_background: true }))?.run_in_background).toBe(false);
  });
});

describe('演员位派发：name 闸（2026-08-28 重构）', () => {
  const mk = () => {
    const roster = createRoleRoster();
    return { roster, cast: makePreToolUseAgentForceForegroundHandler({ roster, workspaceRoot: WS }) };
  };

  it('⭐ 漏传 name → deny 并说清 name 是收件地址（探针实证：deny 一次模型就补上）', async () => {
    const { cast } = mk();
    const out = await cast({ tool_input: { subagent_type: 'rp-actor' } });
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/name/);
  });

  it('⭐ 拿演员位自己的名字当实例名 → deny（rp-actor 是位置不是人）', async () => {
    const { cast } = mk();
    expect(await decision(cast, { subagent_type: 'rp-actor', name: 'rp-narrator' })).toBe('deny');
    expect(await decision(cast, { subagent_type: 'rp-actor', name: 'rp-actor' })).toBe('deny');
  });

  it('合法 name → 强制后台、名字进名册、名字保持是实例名；model 参数被剥掉', async () => {
    const { roster, cast } = mk();
    const out = await cast({ tool_input: { subagent_type: 'rp-actor', name: 'rp-cheng-wan', model: 'sonnet' } });
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(out.hookSpecificOutput.updatedInput.run_in_background).toBe(true);
    expect(out.hookSpecificOutput.updatedInput.name).toBe('rp-cheng-wan');
    expect(out.hookSpecificOutput.updatedInput.model).toBeUndefined();   // 角色跟会话模型走（glm 点 sonnet 案）
    expect(roster.has('rp-cheng-wan')).toBe(true);
    expect(roster.has('rp-actor')).toBe(false);        // 位置不进名册
  });

  it('已显式后台 + 合法 name → 幂等不重复改（但名册照登）', async () => {
    const { roster, cast } = mk();
    expect(await cast({ tool_input: { subagent_type: 'rp-actor', name: 'rp-elle', run_in_background: true } })).toEqual({});
    expect(roster.has('rp-elle')).toBe(true);
  });

  it('⭐ 同名重派被硬拦（重派 = 静默失忆），换名字放行 —— 两个演员位共用一本名册', async () => {
    const { cast } = mk();
    await cast({ tool_input: { subagent_type: 'rp-actor', name: 'rp-cheng-wan' } });
    expect(await decision(cast, { subagent_type: 'rp-actor', name: 'rp-cheng-wan' })).toBe('deny');
    expect(await decision(cast, { subagent_type: 'rp-narrator', name: 'rp-cheng-wan' })).toBe('deny');
    expect(await decision(cast, { subagent_type: 'rp-narrator', name: 'rp-teller' })).toBe('allow');
  });

  it('⭐⭐ 漏传 name 但 prompt 第一行有登记过的卡路径 → 闸自己认出名字（glm 撞闸案）', async () => {
    fs.mkdirSync(path.join(WS, '.nd'), { recursive: true });
    fs.writeFileSync(path.join(WS, '.nd', 'cast.json'), JSON.stringify({
      version: 1,
      roles: { 'rp-izumi': { name: '泉此方', pen: 'narrator', card: '角色/泉此方/角色卡.md' } },
    }), 'utf8');
    const { roster, cast } = mk();
    const out = await cast({ tool_input: { subagent_type: 'rp-narrator', run_in_background: true,
      prompt: '你的角色卡：角色/泉此方/角色卡.md，你的记忆：角色/泉此方/记忆.md\n\n【卡全文】你是泉此方……' } });
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(out.hookSpecificOutput.updatedInput.name).toBe('rp-izumi');   // 推断名必须回写进 input
    expect(roster.has('rp-izumi')).toBe(true);
  });

  it('prompt 正文里写了 name: rp-xxx（模型把参数写错了地方）也认', async () => {
    const { cast } = mk();
    const out = await cast({ tool_input: { subagent_type: 'rp-actor',
      prompt: 'name: rp-hand-written\n\n你的角色卡：（现编的人设）……' } });
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(out.hookSpecificOutput.updatedInput.name).toBe('rp-hand-written');
  });

  it('推不出名字（没参数、没卡路径、没 slug）→ 仍然 deny，出路说了两条', async () => {
    const { cast } = mk();
    const out = await cast({ tool_input: { subagent_type: 'rp-actor', prompt: '你是一个神秘人。' } });
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/角色卡/);
  });

  it('⭐ 演员位文件被改装（tools 行加了外发工具）→ 派发时照样被拦', async () => {
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-resident-evil-'));
    fs.mkdirSync(path.join(ws2, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(ws2, '.claude', 'agents', 'rp-actor.md'),
      slotAgentFile('rp-actor', 'nodesign').replace('tools: ', 'tools: mcp__nodesign__publish_site, '));
    const cast = makePreToolUseAgentForceForegroundHandler({ roster: createRoleRoster(), workspaceRoot: ws2 });
    const out = await cast({ tool_input: { subagent_type: 'rp-actor', name: 'rp-x2' } });
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/publish_site/);
  });
});

describe('旧式一角一定义（会话启动前就在盘上的角色文件）仍走老路', () => {
  it('强制后台 + 把 name 钉成 subagent_type', async () => {
    const h = makePreToolUseAgentForceForegroundHandler({ roster: createRoleRoster() });
    const out = await upd(h, { subagent_type: 'rp-oldstyle' });
    expect(out.run_in_background).toBe(true);
    expect(out.name).toBe('rp-oldstyle');
  });
  it('⭐ 重派同名被硬拦', async () => {
    const h = makePreToolUseAgentForceForegroundHandler({ roster: createRoleRoster() });
    await h({ tool_input: { subagent_type: 'rp-oldstyle' } });
    expect(await decision(h, { subagent_type: 'rp-oldstyle' })).toBe('deny');
  });
});

describe('agentId 别名：同型多实例的身份桥（2026-08-28）', () => {
  beforeEach(() => _resetActorTrail());
  const alias = makePostToolUseSlotAliasHandler();

  it('⭐ 派发的 tool_result 里学 agentId → 实例名', async () => {
    await alias({
      tool_input: { subagent_type: 'rp-actor', name: 'rp-alice' },
      tool_response: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: abcdef0123456789a (use SendMessage...)' }],
    });
    expect(agentNameOf('abcdef0123456789a')).toBe('rp-alice');
  });

  it('⭐ SendMessage 唤醒的 tool_result 里重新学（覆盖重启后别名表清零）', async () => {
    await alias({
      tool_input: { to: 'rp-bob', message: 'hi' },
      tool_response: [{ type: 'text', text: '{"success":true,"message":"Resuming agent rp-bob","resumedAgentId":"a4f15eccfdcb4337f"}' }],
    });
    expect(agentNameOf('a4f15eccfdcb4337f')).toBe('rp-bob');
  });

  it('⭐⭐ 推断名派发（无 name 参数）也学得到别名：PostToolUse 从派发闸的盖章里拿名字（泉此方案）', async () => {
    // 前置：name 闸 describe 已把 rp-izumi 写进 WS 的登记表
    const roster = createRoleRoster();
    const cast = makePreToolUseAgentForceForegroundHandler({ roster, workspaceRoot: WS });
    const ti = { subagent_type: 'rp-narrator', run_in_background: true,
      prompt: '你的角色卡：角色/泉此方/角色卡.md\n【卡全文】……' };
    const out = await cast({ tool_input: ti }, 'toolu_alias_inf');
    expect(out.hookSpecificOutput.updatedInput.name).toBe('rp-izumi');
    // ⛔ PostToolUse 拿到的是模型原始入参（没有 name）—— 泉此方场就是这里断的
    await alias({ tool_input: ti, tool_response: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: 99aabbccddeeff001' }] }, 'toolu_alias_inf');
    expect(agentNameOf('99aabbccddeeff001')).toBe('rp-izumi');
  });

  it('普通子代理与非 rp 收件人不进别名表', async () => {
    await alias({ tool_input: { subagent_type: 'worker', name: 'rp-x9' }, tool_response: [{ type: 'text', text: 'agentId: 1234567890abcdef1' }] });
    await alias({ tool_input: { to: 'main' }, tool_response: [{ type: 'text', text: '{"resumedAgentId":"fedcba0987654321f"}' }] });
    expect(agentNameOf('1234567890abcdef1')).toBe(null);
    expect(agentNameOf('fedcba0987654321f')).toBe(null);
  });

  it('SubagentStop：演员位实例经别名解析成角色；没学到别名就跳过（别把 rp-actor 标进收件箱）', async () => {
    noteAgentName('aaaa000011112222b', 'rp-cheng-wan');
    const stop = makeSubagentStopRoleNotice({ projectId: 'proj_alias_test0' });
    const known = await stop({ agent_type: 'rp-actor', agent_id: 'aaaa000011112222b' });
    expect(known.systemMessage).toMatch(/rp-cheng-wan/);
    const unknown = await stop({ agent_type: 'rp-actor', agent_id: 'ffff000011112222b' });
    expect(unknown).toEqual({});
  });
});

describe('收件人闸：白名单缺省拒绝', () => {
  const mk = () => {
    const roster = createRoleRoster();
    const cast = makePreToolUseAgentForceForegroundHandler({ roster, workspaceRoot: WS });
    const guard = makePreToolUseSendMessageRecipientGuard({ roster });
    return { roster, cast, guard };
  };
  // 演员位派发是名册的正门 —— 闸的放行判据必须跟着实例名走
  const castOne = (cast, name) => cast({ tool_input: { subagent_type: 'rp-actor', name } });

  it('main 和本会话 agentId 放行', async () => {
    const { guard } = mk();
    expect(await decision(guard, { to: 'main' })).toBe('allow');
    expect(await decision(guard, { to: 'a67e7b9568aa4698b' })).toBe('allow');
  });

  it('⭐⭐ H1：本会话没派过的 rp- 名字必须被拒（裸名会落到同机别人的会话上）', async () => {
    const { guard } = mk();
    expect(await decision(guard, { to: 'rp-cheng-wan' })).toBe('deny');
  });

  it('⭐⭐ H1：派过之后才放行 —— 判据是「本会话真派过」不是「名字像角色」', async () => {
    const { cast, guard } = mk();
    expect(await decision(guard, { to: 'rp-cheng-wan' })).toBe('deny');
    await castOne(cast, 'rp-cheng-wan');
    expect(await decision(guard, { to: 'rp-cheng-wan' })).toBe('allow');
    expect(await decision(guard, { to: 'rp-somebody-else' })).toBe('deny');   // 别的名字不跟着开
    expect(await decision(guard, { to: 'rp-actor' })).toBe('deny');           // 位置永远不是收件人
  });

  it('⭐ 同机其他 Claude 会话（真实 ListAgents 输出里的名字）全部拒绝', async () => {
    const { guard } = mk();
    for (const peer of ['wangang-dev-dc', 'shared-b0', 'remote-workplace-1f', 'wangang-dev-c4 [7e27a0]']) {
      expect(await decision(guard, { to: peer })).toBe('deny');
    }
  });

  it('形状不对也拒（白名单闸的缺省必须是拒，不能交给别人校验）', async () => {
    const { guard } = mk();
    for (const bad of [undefined, null, 42, { name: 'main' }, ['main']]) {
      expect(await decision(guard, { to: bad })).toBe('deny');
    }
  });

  it('大小写/空白/同形字都不放过', async () => {
    const { cast, guard } = mk();
    await castOne(cast, 'rp-cheng-wan');
    expect(await decision(guard, { to: '  rp-cheng-wan  ' })).toBe('allow');   // trim 是有意的
    expect(await decision(guard, { to: 'RP-cheng-wan' })).toBe('deny');
    expect(await decision(guard, { to: 'rp-cheng-wan [3fa9c1]' })).toBe('deny');
    expect(await decision(guard, { to: 'rp-cheng-wan​' })).toBe('deny');  // 零宽
    expect(await decision(guard, { to: 'rр-cheng-wan' })).toBe('deny');        // 西里尔 р
  });

  it('⭐ 没接名册时 fail-closed，不退回形状判据（静默降级是这个仓库的老病）', async () => {
    const bare = makePreToolUseSendMessageRecipientGuard();
    expect(await decision(bare, { to: 'rp-cheng-wan' })).toBe('deny');
    expect(await decision(bare, { to: 'main' })).toBe('allow');          // main 仍走得通
  });

  it('allow 时把 trim 后的收件人回写，别让闸判的和工具收的是两个字符串', async () => {
    const { cast, guard } = mk();
    await castOne(cast, 'rp-cheng-wan');
    const out = await guard({ tool_input: { to: '  rp-cheng-wan  ', message: 'hi' } });
    expect(out.hookSpecificOutput.updatedInput.to).toBe('rp-cheng-wan');
    expect(out.hookSpecificOutput.updatedInput.message).toBe('hi');       // 别的入参原样
  });

  it('两个 handler 必须共享同一份名册 —— 各建各的等于闸永远看到空名册', async () => {
    const cast = makePreToolUseAgentForceForegroundHandler({ roster: createRoleRoster(), workspaceRoot: WS });
    const guard = makePreToolUseSendMessageRecipientGuard({ roster: createRoleRoster() });
    await castOne(cast, 'rp-cheng-wan');
    expect(await decision(guard, { to: 'rp-cheng-wan' })).toBe('deny');        // 没共享 → fail-closed
  });
});

describe('派发失败 → 名字撤回（claim 在派发之前，失败了必须还回去）', () => {
  const mk = () => {
    const roster = createRoleRoster();
    return {
      roster,
      cast: makePreToolUseAgentForceForegroundHandler({ roster, workspaceRoot: WS }),
      guard: makePreToolUseSendMessageRecipientGuard({ roster }),
      onFail: makePostToolUseFailureRoleRelease({ roster }),
    };
  };

  it('⭐ 演员位派发失败：撤的是实例名（tool_input.name），不是演员位', async () => {
    const { cast, guard, onFail } = mk();
    await cast({ tool_input: { subagent_type: 'rp-actor', name: 'rp-cheng-wan' } });
    expect(await decision(guard, { to: 'rp-cheng-wan' })).toBe('allow');
    await onFail({ tool_input: { subagent_type: 'rp-actor', name: 'rp-cheng-wan' }, error: 'boom' });
    expect(await decision(guard, { to: 'rp-cheng-wan' })).toBe('deny');
  });

  it('⭐ 派发失败后可以再派（不然这个名字整个会话被 brick）', async () => {
    const { cast, onFail } = mk();
    await cast({ tool_input: { subagent_type: 'rp-actor', name: 'rp-cheng-wan' } });
    expect(await decision(cast, { subagent_type: 'rp-actor', name: 'rp-cheng-wan' })).toBe('deny');
    await onFail({ tool_input: { subagent_type: 'rp-actor', name: 'rp-cheng-wan' }, error: 'boom' });
    expect(await decision(cast, { subagent_type: 'rp-actor', name: 'rp-cheng-wan' })).toBe('allow');
  });

  it('普通子代理失败不碰名册', async () => {
    const { roster, cast, onFail } = mk();
    await cast({ tool_input: { subagent_type: 'rp-actor', name: 'rp-cheng-wan' } });
    await onFail({ tool_input: { subagent_type: 'worker' }, error: 'boom' });
    expect(roster.list()).toEqual(['rp-cheng-wan']);
  });
});
