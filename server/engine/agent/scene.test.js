/**
 * scene.js 测试 —— 钉轮次机的节拍语义。
 *
 * 机器的信号全是间接的（deliver / roleWait），错了不报错，只会让某个角色永远等不到
 * cue 或者被跳过 —— 所以这里把整圈流程一步步走出来断言，尤其是那个时序闸：
 * 「带着积压挂上 = 拾取不是拍尾」。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  setScene, getScene, onUserSay, onRoleWait, passTurn, cueMessage,
  clearScene, _resetScenes,
} from './scene.js';
import { deliver, drain, queueDepth, _resetInboxes } from './inbox.js';

const P = 'proj_scene_test0';
const A = 'rp-a'; const B = 'rp-b'; const C = 'rp-c';

beforeEach(() => { _resetScenes(); _resetInboxes(); });

describe('setScene', () => {
  it('声明与校验：非法值当场炸，rounds 人数不足给 warn', () => {
    expect(() => setScene(P, { mode: 'battle' })).toThrow(/mode 非法/);
    expect(() => setScene(P, { order: ['not-a-role'] })).toThrow(/不是角色 slug/);
    const { warn } = setScene(P, { mode: 'rounds', order: [A] });
    expect(warn).toMatch(/少于 2 人/);
    const ok = setScene(P, { order: [A, B], note: '雨夜酒馆' });
    expect(ok.warn).toBeNull();
    expect(getScene(P)).toMatchObject({ mode: 'rounds', order: [A, B], note: '雨夜酒馆', turnSlug: null });
  });

  it('换模式/换顺序清掉进行中的一轮（旧指针指进新顺序是乱指）', () => {
    setScene(P, { mode: 'rounds', order: [A, B] });
    onUserSay(P, A);
    expect(getScene(P).turnSlug).toBe(A);
    setScene(P, { order: [B, A, C] });
    expect(getScene(P).turnSlug).toBeNull();
  });
});

describe('轮次机（rounds）', () => {
  it('整圈：用户对 A 说 → A 拍尾 cue B → B 拍尾收轮', () => {
    setScene(P, { mode: 'rounds', order: [A, B] });
    deliver(P, A, { text: '你好', from: 'user' });
    expect(onUserSay(P, A)?.turnSlug).toBe(A);

    // A 消费掉用户的话（队列清空），然后重新挂上 = 拍尾
    drain(P, A);
    const afterA = onRoleWait(P, A, true);
    expect(afterA?.turnSlug).toBe(B);
    // B 的收件箱里躺着 cue，标 from:'scene'，话术点名上一个说话的人
    const cues = drain(P, B);
    expect(cues).toHaveLength(1);
    expect(cues[0].from).toBe('scene');
    expect(cues[0].text).toBe(cueMessage(A));

    // B 拍尾 → 一圈走完
    const afterB = onRoleWait(P, B, true);
    expect(afterB?.turnSlug).toBeNull();
    expect(getScene(P).turnSlug).toBeNull();
  });

  it('时序闸：带着积压挂上是「拾取」不是「拍尾」，不推进', () => {
    setScene(P, { mode: 'rounds', order: [A, B] });
    deliver(P, A, { text: '第一句', from: 'user' });
    onUserSay(P, A);
    // A 还没读（队列非空）就挂上 —— await_user 的 emit 发生在 waitFor 之前，正是这个时刻
    expect(onRoleWait(P, A, true)).toBeNull();
    expect(getScene(P).turnSlug).toBe(A);
    // 用户连发第二句，A 写完一段再挂上 —— 队列仍非空，轮次还是不走（话不被截走）
    deliver(P, A, { text: '第二句', from: 'user' });
    drain(P, A); deliver(P, A, { text: '第三句', from: 'user' });
    expect(onRoleWait(P, A, true)).toBeNull();
    // 全消费完再挂上，这才是拍尾
    drain(P, A);
    expect(onRoleWait(P, A, true)?.turnSlug).toBe(B);
  });

  it('不归机器管的情况都安静：非 rounds / 没开轮 / 没轮到它 / 不在表里', () => {
    expect(onUserSay(P, A)).toBeNull();                       // 没设过场
    setScene(P, { mode: 'free', order: [A, B] });
    expect(onUserSay(P, A)).toBeNull();                       // free 无机器
    setScene(P, { mode: 'rounds', order: [A, B] });
    expect(onRoleWait(P, A, true)).toBeNull();                // 没开轮
    expect(onUserSay(P, C)).toBeNull();                       // C 不在表里
    onUserSay(P, A);
    expect(onRoleWait(P, B, true)).toBeNull();                // 没轮到 B
    expect(onRoleWait(P, A, false)).toBeNull();               // 离开等待不是信号
    expect(getScene(P).turnSlug).toBe(A);
  });

  it('pass_turn：轮到我才跳；跳到队尾收轮', () => {
    setScene(P, { mode: 'rounds', order: [A, B] });
    expect(passTurn(P, A).scene).toBeNull();                  // 没开轮
    onUserSay(P, A);
    expect(passTurn(P, B).scene).toBeNull();                  // 没轮到 B
    const r1 = passTurn(P, A);
    expect(r1.scene.turnSlug).toBe(B);
    expect(r1.msg).toContain(B);
    expect(queueDepth(P, B)).toBe(1);                         // 跳过也要 cue 下一个
    const r2 = passTurn(P, B);
    expect(r2.scene.turnSlug).toBeNull();
    expect(r2.msg).toContain('收尾');
  });

  it('cue 投给没在等的角色进队列（inbox 既有语义），指针停在它身上可见', () => {
    setScene(P, { mode: 'rounds', order: [A, B] });
    onUserSay(P, A);
    onRoleWait(P, A, true);
    expect(getScene(P).turnSlug).toBe(B);
    expect(queueDepth(P, B)).toBe(1);
  });

  it('clearScene 收摊', () => {
    setScene(P, { mode: 'rounds', order: [A, B] });
    clearScene(P);
    expect(getScene(P)).toBeNull();
  });
});
