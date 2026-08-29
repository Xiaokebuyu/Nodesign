// 在飞台账（2026-08-28 建；08-29 简化）—— ws grace 闸「别把还在写的角色腰斩」的判据。
//
// 08-29 之前判据是「在飞 − 候场」（角色写完会挂 await_user 不收回合）。收件箱整族
// 退役后角色写一段就结束一轮，减数没有了，判据只剩「起飞了还没落地」。钉的是：
// 算少了就是 08-28 那次腰斩重演。
import { describe, it, expect, beforeEach } from 'vitest';
import { noteSubagentStart, noteSubagentStop, workingSubagents, clearSessionFlights, _resetSubagentFlight } from './subagent-flight.js';
import { noteAgentName, _resetActorTrail } from './actor-trail.js';

const SID = 'sess-1';
const P = 'proj_x';

beforeEach(() => { _resetSubagentFlight(); _resetActorTrail(); });

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

describe('名字解析', () => {
  it('别名学到了就带上实例名；没学到也照样算在飞', () => {
    noteSubagentStart(SID, 'a1', 'rp-role');
    noteAgentName('a1', 'rp-izumi');
    noteSubagentStart(SID, 'a9', 'general-purpose');
    const w = workingSubagents(SID, P);
    expect(w).toHaveLength(2);
    expect(w.find((x) => x.agentId === 'a1').name).toBe('rp-izumi');
    expect(w.find((x) => x.agentId === 'a9').name).toBeNull();
  });

  it('projectId 是旧签名的兼容位，给不给都一样', () => {
    noteSubagentStart(SID, 'a1', 'rp-role');
    expect(workingSubagents(SID)).toHaveLength(1);
    expect(workingSubagents(SID, P)).toHaveLength(1);
  });
});
