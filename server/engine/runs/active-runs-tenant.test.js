/** 会话句柄按项目取（09-13，fable 审查 P2-4 引出的跨租户洞）：sid 属于别的项目就当不存在。 */
import { describe, it, expect, afterEach } from 'vitest';
import { registerQuerySession, unregisterQuerySession, querySessionInProject, querySessionBelongsElsewhere, getQuerySession } from './active-runs.js';
import { AsyncQueue } from '../../lib/async-queue.js';

const SID = '11111111-2222-3333-4444-555555555555';
afterEach(() => { unregisterQuerySession(SID); });

describe('querySessionInProject', () => {
  it('⭐ 带 projectId 注册：本项目取得到，别的项目取不到且判为「属于别处」', () => {
    registerQuerySession(SID, { abortController: new AbortController(), inputQueue: new AsyncQueue(), projectId: 'proj_a' });
    expect(querySessionInProject(SID, 'proj_a')).toBe(getQuerySession(SID));
    expect(querySessionInProject(SID, 'proj_b')).toBeNull();
    expect(querySessionBelongsElsewhere(SID, 'proj_b')).toBe(true);
    expect(querySessionBelongsElsewhere(SID, 'proj_a')).toBe(false);
  });
  it('没有活口会话 → 不是「属于别处」（新会话 / 已关的会话照常走各自的路）', () => {
    expect(querySessionBelongsElsewhere(SID, 'proj_a')).toBe(false);
    expect(querySessionInProject(SID, 'proj_a')).toBeNull();
  });
  it('注册没带 projectId（探针 / 单测直连）不拦', () => {
    registerQuerySession(SID, { abortController: new AbortController(), inputQueue: new AsyncQueue() });
    expect(querySessionInProject(SID, 'proj_x')).not.toBeNull();
  });
});
