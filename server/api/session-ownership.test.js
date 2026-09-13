import { describe, it, expect } from 'vitest';
import { clientSessionBelongsToProject } from './session-ownership.js';

const P = 'proj_mine_0001';
const deps = (o = {}) => ({
  inProject: () => null, elsewhere: () => false, projectsOf: () => [], hasJsonl: async () => false, ...o,
});

describe('客户端带来的 sid 算不算本项目的会话（09-13 fable 审查 P1-3）', () => {
  it('正在本项目里跑 → 是；正在别的项目里跑 → 不是', async () => {
    expect(await clientSessionBelongsToProject(P, 's', deps({ inProject: () => ({}) }))).toBe(true);
    expect(await clientSessionBelongsToProject(P, 's', deps({ elsewhere: () => true, hasJsonl: async () => true }))).toBe(false);
  });

  it('⭐ 抢注：受害者会话空闲（活口表里没有），runs 记着它在别的项目跑过 → 不是', async () => {
    expect(await clientSessionBelongsToProject(P, 's', deps({ projectsOf: () => ['proj_victim_001'] }))).toBe(false);
    // 就算本项目下碰巧也有同名转录，历史落在别处也不认
    expect(await clientSessionBelongsToProject(P, 's', deps({ projectsOf: () => [P, 'proj_victim_001'], hasJsonl: async () => true }))).toBe(false);
  });

  it('本项目跑过（runs）或本项目下有转录（07-31 前的老会话 runs 没记 sid）→ 是', async () => {
    expect(await clientSessionBelongsToProject(P, 's', deps({ projectsOf: () => [P] }))).toBe(true);
    expect(await clientSessionBelongsToProject(P, 's', deps({ hasJsonl: async () => true }))).toBe(true);
  });

  it('哪儿都没见过的 sid（编的 / 抄来的）→ 不是', async () => {
    expect(await clientSessionBelongsToProject(P, 's', deps())).toBe(false);
  });

  it('真表：projectIdsForSession 按 session_id 查出去重的项目', async () => {
    const { createRun, projectIdsForSession } = await import('../engine/runs/store.js');
    const sid = `sid-own-${Date.now()}`;
    createRun({ skillId: 'x', brief: 'b', projectId: 'proj_a_000001', sessionId: sid });
    createRun({ skillId: 'x', brief: 'b', projectId: 'proj_a_000001', sessionId: sid });
    createRun({ skillId: 'x', brief: 'b', projectId: 'proj_b_000001', sessionId: sid });
    expect(projectIdsForSession(sid).sort()).toEqual(['proj_a_000001', 'proj_b_000001']);
    expect(projectIdsForSession('sid-never-seen')).toEqual([]);
  });
});
