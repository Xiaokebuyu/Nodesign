// 常驻角色这条链的回归闸（2026-08-26）
//
// 为什么是「一条链一个测试文件」而不是按源文件切：这条链的正确性不在任何单个
// 函数里，而在**判据、名册、两个 handler 的联动**上 —— H1 那个洞就是判据本身
// 写对了、闸也调对了，但判据问错了问题（问"名字像不像"而不是"本会话有没有"）。
//
// 这些断言原来只活在 _probe-resident-agent.mjs 里，而探针是一次性的、不进
// npm test。收件人闸的失效模式是 fail-open（闸不跑 = 全放行、零症状），这个
// 仓库为「hook 静默死」付过三次账，所以它需要一个每次 CI 都醒着的哨兵。
import { describe, it, expect } from 'vitest';
import { isResidentRole, createRoleRoster } from '../cast.js';
import { normalizeBy } from '../../../lib/chalk.js';
import { sanitizeObject } from '../../../projects/board-sanitize.js';

/** 借 sanitizeObject 探一个 by 值落不落得下来（board-sanitize 是 by 的读者之一） */
const sanitizeObjectBy = (by) => sanitizeObject({ x: 0, y: 0, by })?.by;
import { makePreToolUseAgentForceForegroundHandler } from './pre-defaults.js';
import { makePreToolUseSendMessageRecipientGuard } from './pre-peer-guard.js';
import { makePostToolUseFailureRoleRelease } from './resident-role-lifecycle.js';

const upd = async (h, tool_input) => (await h({ tool_input }))?.hookSpecificOutput?.updatedInput ?? null;
const decision = async (h, tool_input) => (await h({ tool_input }))?.hookSpecificOutput?.permissionDecision ?? 'allow';

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
    // 收之前这条正则有三份拷贝，且裂了一道缝：isResidentRole 放行 `rp--x`，
    // 而两个落盘白名单不放行 → 派发成功、名册登记、byOf 也认，但落盘时 by 被静默
    // 剥掉（板上没归属、板书 frontmatter 折回 agent）。现在三处共用 ROLE_SLUG_RE。
    expect(isResidentRole('rp--x')).toBe(false);
    expect(isResidentRole('rp-_x')).toBe(false);
    expect(normalizeBy('rp--x')).toBe('agent');
    expect(sanitizeObjectBy('rp--x')).toBeUndefined();
  });

  it('64 字符上限跟 CLI 的收件人名校验对齐', () => {
    expect(isResidentRole('rp-' + 'a'.repeat(61))).toBe(true);    // 共 64
    expect(isResidentRole('rp-' + 'a'.repeat(62))).toBe(false);   // 65 → CLI 会拒
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

describe('前台/后台：常驻角色走反方向', () => {
  it('强制后台 + 把 name 钉成 subagent_type（模型自己不传 name）', async () => {
    const h = makePreToolUseAgentForceForegroundHandler({ roster: createRoleRoster() });
    const out = await upd(h, { subagent_type: 'rp-narrator' });
    expect(out.run_in_background).toBe(true);
    expect(out.name).toBe('rp-narrator');
  });
  it('已经对了 → 幂等不重复改', async () => {
    const h = makePreToolUseAgentForceForegroundHandler({ roster: createRoleRoster() });
    await h({ tool_input: { subagent_type: 'rp-narrator' } });           // 先登记
    const roster2 = createRoleRoster();
    const h2 = makePreToolUseAgentForceForegroundHandler({ roster: roster2 });
    expect(await h2({ tool_input: { subagent_type: 'rp-narrator', run_in_background: true, name: 'rp-narrator' } })).toEqual({});
  });
  it('⭐ 重派同名角色被硬拦 —— 重派 = 静默失忆（latest wins 顶掉旧角色）', async () => {
    const h = makePreToolUseAgentForceForegroundHandler({ roster: createRoleRoster() });
    await h({ tool_input: { subagent_type: 'rp-narrator' } });
    expect(await decision(h, { subagent_type: 'rp-narrator' })).toBe('deny');
  });
});

describe('收件人闸：白名单缺省拒绝', () => {
  const mk = () => {
    const roster = createRoleRoster();
    const cast = makePreToolUseAgentForceForegroundHandler({ roster });
    const guard = makePreToolUseSendMessageRecipientGuard({ roster });
    return { roster, cast, guard };
  };

  it('main 和本会话 agentId 放行', async () => {
    const { guard } = mk();
    expect(await decision(guard, { to: 'main' })).toBe('allow');
    expect(await decision(guard, { to: 'a67e7b9568aa4698b' })).toBe('allow');
  });

  it('⭐⭐ H1：本会话没派过的 rp- 名字必须被拒（裸名会落到同机别人的会话上）', async () => {
    const { guard } = mk();
    expect(await decision(guard, { to: 'rp-narrator' })).toBe('deny');
  });

  it('⭐⭐ H1：派过之后才放行 —— 判据是「本会话真派过」不是「名字像角色」', async () => {
    const { cast, guard } = mk();
    expect(await decision(guard, { to: 'rp-narrator' })).toBe('deny');
    await cast({ tool_input: { subagent_type: 'rp-narrator' } });
    expect(await decision(guard, { to: 'rp-narrator' })).toBe('allow');
    expect(await decision(guard, { to: 'rp-somebody-else' })).toBe('deny');   // 别的名字不跟着开
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
    await cast({ tool_input: { subagent_type: 'rp-narrator' } });
    expect(await decision(guard, { to: '  rp-narrator  ' })).toBe('allow');   // trim 是有意的
    expect(await decision(guard, { to: 'RP-narrator' })).toBe('deny');
    expect(await decision(guard, { to: 'rp-narrator [3fa9c1]' })).toBe('deny');
    expect(await decision(guard, { to: 'rp-narrator​' })).toBe('deny');  // 零宽
    expect(await decision(guard, { to: 'rр-narrator' })).toBe('deny');        // 西里尔 р
  });

  it('⭐ 没接名册时 fail-closed，不退回形状判据（静默降级是这个仓库的老病）', async () => {
    const bare = makePreToolUseSendMessageRecipientGuard();
    expect(await decision(bare, { to: 'rp-narrator' })).toBe('deny');
    expect(await decision(bare, { to: 'main' })).toBe('allow');          // main 仍走得通
  });

  it('allow 时把 trim 后的收件人回写，别让闸判的和工具收的是两个字符串', async () => {
    const { cast, guard } = mk();
    await cast({ tool_input: { subagent_type: 'rp-narrator' } });
    const out = await guard({ tool_input: { to: '  rp-narrator  ', message: 'hi' } });
    expect(out.hookSpecificOutput.updatedInput.to).toBe('rp-narrator');
    expect(out.hookSpecificOutput.updatedInput.message).toBe('hi');       // 别的入参原样
  });

  it('两个 handler 必须共享同一份名册 —— 各建各的等于闸永远看到空名册', async () => {
    const cast = makePreToolUseAgentForceForegroundHandler({ roster: createRoleRoster() });
    const guard = makePreToolUseSendMessageRecipientGuard({ roster: createRoleRoster() });
    await cast({ tool_input: { subagent_type: 'rp-narrator' } });
    expect(await decision(guard, { to: 'rp-narrator' })).toBe('deny');        // 没共享 → fail-closed
  });
});

describe('派发失败 → 名字撤回（claim 在派发之前，失败了必须还回去）', () => {
  const mk = () => {
    const roster = createRoleRoster();
    return {
      roster,
      cast: makePreToolUseAgentForceForegroundHandler({ roster }),
      guard: makePreToolUseSendMessageRecipientGuard({ roster }),
      onFail: makePostToolUseFailureRoleRelease({ roster }),
    };
  };

  it('⭐ 派发失败后名字不再被闸放行（否则裸名回落全机解析 = H1 在窄窗口重开）', async () => {
    const { cast, guard, onFail } = mk();
    await cast({ tool_input: { subagent_type: 'rp-narrator' } });
    expect(await decision(guard, { to: 'rp-narrator' })).toBe('allow');
    await onFail({ tool_input: { subagent_type: 'rp-narrator' }, error: 'Agent type not found' });
    expect(await decision(guard, { to: 'rp-narrator' })).toBe('deny');
  });

  it('⭐ 派发失败后可以再派（不然这个名字整个会话被 brick）', async () => {
    const { cast, onFail } = mk();
    await cast({ tool_input: { subagent_type: 'rp-narrator' } });
    expect(await decision(cast, { subagent_type: 'rp-narrator' })).toBe('deny');   // 在场时重派拒
    await onFail({ tool_input: { subagent_type: 'rp-narrator' }, error: 'boom' });
    const out = await upd(cast, { subagent_type: 'rp-narrator' });                  // 撤回后放行
    expect(out?.run_in_background).toBe(true);
  });

  it('普通子代理失败不碰名册', async () => {
    const { roster, cast, onFail } = mk();
    await cast({ tool_input: { subagent_type: 'rp-narrator' } });
    await onFail({ tool_input: { subagent_type: 'worker' }, error: 'boom' });
    expect(roster.list()).toEqual(['rp-narrator']);
  });
});

describe('本回合刚造的角色派不动（CLI 只在回合边界重扫角色目录）', () => {
  // 2026-08-26 对照实验：同回合内造完就派必然 not found，等 3.5s / 12s / reinitialize
  // 全都无效，唯一有效的差别是"隔了一个回合"。而模型不听劝 —— 工具返回里写明
  // "这一回合派不了"之后它照派不误，失败了还回一句"已派"谎报。所以结构性拦掉。
  const mk = () => {
    const roster = createRoleRoster();
    const ctx = { runId: 'run-1' };
    return { roster, ctx, cast: makePreToolUseAgentForceForegroundHandler({ roster, ctx }) };
  };

  it('⭐ 同一回合造完就派 → deny，并说清楚怎么办', async () => {
    const { roster, ctx, cast } = mk();
    roster.noteCast('rp-moli', ctx.runId);
    const out = await cast({ tool_input: { subagent_type: 'rp-moli' } });
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/这一回合|下一条消息/);
  });

  it('⭐ 换了回合就放行（这才是它能派出去的真正条件）', async () => {
    const { roster, ctx, cast } = mk();
    roster.noteCast('rp-moli', ctx.runId);
    ctx.runId = 'run-2';                     // 真实 session-loop 每个回合换 runId
    const out = await cast({ tool_input: { subagent_type: 'rp-moli' } });
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(out.hookSpecificOutput.updatedInput.run_in_background).toBe(true);
  });

  it('没记过的角色不受影响', async () => {
    const { cast } = mk();
    const out = await cast({ tool_input: { subagent_type: 'rp-other' } });
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
  });
});
