// 收尾闸（2026-08-29）：主持人写完一拍要么给按钮、要么交给角色，两样都没有不许收工。
//
// 这条闸的存在理由是话术拦不住 —— 08-28 真会话里「每拍给一个决定点」在提示词里
// 写了整整一节，模型照旧写完两千字就收工，玩家只能打出「接下来该怎么办」。
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../rp-mode.js', () => ({ isRpProject: (pid) => pid === 'proj_rp' }));

const { makePostToolUseBeatWrite, makePostToolUseBeatHandoff, makeStopBeatGate } = await import('./beat-gate.js');
const { _resetBeatState } = await import('../beat-state.js');

const SID = 'sess-beat';
const RP = { sessionId: SID, projectId: 'proj_rp' };

beforeEach(() => _resetBeatState());

const write = (input) => makePostToolUseBeatWrite(RP)(input);
const handoff = (input) => makePostToolUseBeatHandoff(RP)(input);
const stop = (input = {}) => makeStopBeatGate(RP)(input);

describe('拦得住的那一种', () => {
  it('⭐ 写了正文、没按钮、没交给谁 → block 一次，话里给两条出路', async () => {
    await write({ tool_input: { text: '城门在暮色里合拢。' } });
    const out = await stop();
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(/SendMessage/);
    expect(out.reason).toMatch(/nd:controls/);
  });

  it('⛔ 只拦一次：拦过之后（stop_hook_active）一律放行，别拦成死循环', async () => {
    await write({ tool_input: { text: '正文' } });
    expect((await stop({ stop_hook_active: true })).decision).toBeUndefined();
  });
});

describe('不该拦的都别拦', () => {
  it('正文里带了 nd:controls 围栏 → 放行', async () => {
    await write({ tool_input: { text: '正文\n```nd:controls\n- [A] 跟上去 -> 选A\n```' } });
    expect((await stop()).decision).toBeUndefined();
  });

  it('board_batch 的某一件带按钮也算数（一车发的常见形态）', async () => {
    await write({ tool_input: { ops: [{ text: '正文' }, { text: '```nd:controls\n- [A] 走 -> A\n```' }] } });
    expect((await stop()).decision).toBeUndefined();
  });

  it('这一拍交给角色了（派它上场 / 寄话给它）→ 放行', async () => {
    await write({ tool_input: { text: '正文' } });
    await handoff({ tool_input: { to: 'rp-moli', message: '该你了' } });
    expect((await stop()).decision).toBeUndefined();

    _resetBeatState();
    await write({ tool_input: { text: '正文' } });
    await handoff({ tool_input: { subagent_type: 'rp-role', name: 'rp-moli' } });
    expect((await stop()).decision).toBeUndefined();
  });

  it('⭐ 角色自己写的板书不算「这一拍收完了」—— 它写完正是主持人该收尾的时候', async () => {
    await write({ agent_id: 'a1', tool_input: { text: '「今夜风紧。」' } });
    expect((await stop()).decision).toBeUndefined();   // 主持人这一轮压根没写，不拦
    await write({ tool_input: { text: '主持人的一拍' } });
    expect((await stop()).decision).toBe('block');
  });

  it('这一轮没往画布上写东西（纯聊天/纯场记）→ 放行', async () => {
    expect((await stop()).decision).toBeUndefined();
  });

  it('设计模式的项目一律不管', async () => {
    const design = { sessionId: SID, projectId: 'proj_design' };
    await makePostToolUseBeatWrite(design)({ tool_input: { text: '正文' } });
    expect((await makeStopBeatGate(design)({})).decision).toBeUndefined();
  });
});
