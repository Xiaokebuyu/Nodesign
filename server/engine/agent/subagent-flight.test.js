// 在飞台账（2026-08-28）—— ws grace 闸「别把后台角色腰斩」的判据。
//
// 这条判定的命门是**在飞 − 候场**：算多了（把候场的角色算成在干活），一个挂着
// await_user 的角色就能让会话永远关不掉，250MB 的 SDK 进程在 swap=0 的盒子上不还；
// 算少了（把在写的角色漏掉），就是 08-28 泉此方场那次腰斩重演。两边都要钉死。
import { describe, it, expect, beforeEach } from 'vitest';
import { noteSubagentStart, noteSubagentStop, workingSubagents, clearSessionFlights, _resetSubagentFlight } from './subagent-flight.js';
import { noteAgentName, _resetActorTrail } from './actor-trail.js';
import { waitFor, _resetInboxes } from './inbox.js';

const SID = 'sess-1';
const P = 'proj_x';

beforeEach(() => { _resetSubagentFlight(); _resetActorTrail(); _resetInboxes(); });

describe('起飞落地', () => {
  it('起飞进账、落地销账', () => {
    noteSubagentStart(SID, 'a1', 'rp-actor');
    expect(workingSubagents(SID, P)).toHaveLength(1);
    noteSubagentStop(SID, 'a1');
    expect(workingSubagents(SID, P)).toHaveLength(0);
  });

  it('会话之间不串账', () => {
    noteSubagentStart(SID, 'a1', 'rp-actor');
    noteSubagentStart('sess-2', 'a2', 'rp-actor');
    expect(workingSubagents(SID, P)).toHaveLength(1);
    expect(workingSubagents('sess-2', P)).toHaveLength(1);
    clearSessionFlights(SID);
    expect(workingSubagents(SID, P)).toHaveLength(0);
    expect(workingSubagents('sess-2', P)).toHaveLength(1);
  });

  it('缺胳膊少腿的参数不炸也不进账', () => {
    noteSubagentStart(null, 'a1'); noteSubagentStart(SID, null);
    noteSubagentStop(null, 'a1'); noteSubagentStop(SID, 'never-started');
    expect(workingSubagents(SID, P)).toHaveLength(0);
  });
});

describe('⭐ 候场的不算在干活', () => {
  it('角色挂 await_user 候场 → 从在干活里减掉（否则会话永远关不掉）', async () => {
    noteSubagentStart(SID, 'a1', 'rp-actor');
    noteAgentName('a1', 'rp-izumi');            // 别名桥：agentId → 实例名
    expect(workingSubagents(SID, P)).toHaveLength(1);   // 还在写

    waitFor(P, 'rp-izumi', 5000);                        // 角色挂上候场
    await new Promise((r) => { setTimeout(r, 0); });
    expect(workingSubagents(SID, P)).toHaveLength(0);    // 候场 → 不续命
  });

  it('同会话里一个候场一个在写 → 只剩在写的那个续命', async () => {
    noteSubagentStart(SID, 'a1', 'rp-actor'); noteAgentName('a1', 'rp-izumi');
    noteSubagentStart(SID, 'a2', 'rp-actor'); noteAgentName('a2', 'rp-tono');
    waitFor(P, 'rp-izumi', 5000);
    await new Promise((r) => { setTimeout(r, 0); });
    const w = workingSubagents(SID, P);
    expect(w).toHaveLength(1);
    expect(w[0].name).toBe('rp-tono');
  });

  it('⛔ 翻不出实例名的按「在干活」算 —— 漏判成候场就是又一次腰斩', () => {
    noteSubagentStart(SID, 'a9', 'general-purpose');    // 普通后台子代理，没有候场形态
    expect(workingSubagents(SID, P)).toHaveLength(1);
  });

  it('没给 projectId 时不做候场判定（宁可续命，别误杀）', async () => {
    noteSubagentStart(SID, 'a1', 'rp-actor'); noteAgentName('a1', 'rp-izumi');
    waitFor(P, 'rp-izumi', 5000);
    await new Promise((r) => { setTimeout(r, 0); });
    expect(workingSubagents(SID, null)).toHaveLength(1);
  });
});
