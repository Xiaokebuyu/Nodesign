// 台上名单：三种事件 → 一张表（2026-08-26）
//
// 为什么要钉：这张表决定侧栏那行提示，而那行提示回答的是「我现在能不能发消息」。
// 说错一次用户就不敢打字了 —— 上一个把这件事说错的 bug（子代理说话铸出永不收的
// 主回合，按钮卡在「停止」）直接导致用户中止了自己的会话。
import { describe, it, expect } from 'vitest';
import { reduceRoleStage, stageHint } from './role-stage.js';

const run = (evts, init = {}) => evts.reduce(reduceRoleStage, init);

describe('谁在台上', () => {
  it('上场进表，下场出表', () => {
    const s = run([{ type: 'run.subagent.start', agentType: 'rp-moli' }]);
    expect(s).toEqual({ 'rp-moli': { waiting: false } });
    expect(run([{ type: 'run.subagent.stop', agentType: 'rp-moli' }], s)).toEqual({});
  });

  it('⭐ 干活型子代理不进这张表（它不是台上的角色）', () => {
    expect(run([
      { type: 'run.subagent.start', agentType: 'vision-checker' },
      { type: 'run.subagent.stop', agentType: 'general-purpose' },
    ])).toEqual({});
  });

  it('⭐ 上场事件被 stale 吞掉时，run.role.wait 兜底立条目', () => {
    // 真实路径：角色先写板再挂 await_user，而 subagent.start 可能没进来
    expect(run([{ type: 'run.role.wait', slug: 'rp-moli', waiting: true }]))
      .toEqual({ 'rp-moli': { waiting: true } });
  });

  it('挂上/离开 await_user 只切 waiting，不改在场', () => {
    let s = run([{ type: 'run.subagent.start', agentType: 'rp-moli' }]);
    s = run([{ type: 'run.role.wait', slug: 'rp-moli', waiting: true }], s);
    expect(s['rp-moli'].waiting).toBe(true);
    s = run([{ type: 'run.role.wait', slug: 'rp-moli', waiting: false }], s);
    expect(s['rp-moli'].waiting).toBe(false);
  });

  it('没变化时原样返回（省一次渲染）', () => {
    const s = { 'rp-moli': { waiting: true } };
    expect(reduceRoleStage(s, { type: 'run.role.wait', slug: 'rp-moli', waiting: true })).toBe(s);
    expect(reduceRoleStage(s, { type: 'run.done' })).toBe(s);
    expect(reduceRoleStage(s, { type: 'run.subagent.stop', agentType: 'rp-nobody' })).toBe(s);
  });
});

describe('侧栏那行提示', () => {
  it('台上没人就不显示', () => {
    expect(stageHint({})).toBeNull();
  });

  it('一个人报名字，多个人报「等 N 人」', () => {
    const names = { 'rp-moli': '墨璃', 'rp-yanqing': '砚青' };
    expect(stageHint({ 'rp-moli': { waiting: true } }, names).label).toBe('墨璃');
    expect(stageHint({ 'rp-moli': { waiting: true }, 'rp-yanqing': { waiting: true } }, names).label)
      .toBe('墨璃 等 2 人');
  });

  it('查不到展示名就退回 slug（宁可难看也不能张冠李戴）', () => {
    expect(stageHint({ 'rp-moli': { waiting: true } }, {}).label).toBe('rp-moli');
  });

  it('⭐ 有一个在写就算「在写」—— 别把还在动的场面说成安静', () => {
    expect(stageHint({ a: { waiting: true } }).allWaiting).toBe(true);
    expect(stageHint({ 'rp-a': { waiting: true }, 'rp-b': { waiting: false } }).allWaiting).toBe(false);
  });
});
