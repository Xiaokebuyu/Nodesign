import { describe, it, expect, vi } from 'vitest';
import { stopSessionTask } from './task-stop.js';

const deps = ({ runId = 'run_1', projectId = 'proj_a', stopTask = vi.fn(async () => {}) } = {}) => ({
  getCurrentTurnRunId: () => runId,
  getRun: (id) => (id === 'run_1' ? { id, projectId } : null),
  getQuerySession: () => ({ query: { stopTask } }),
  stopTask,
});

describe('stopSessionTask', () => {
  it('⭐ 回合属于这个项目 → 调 query.stopTask(taskId)', async () => {
    const d = deps();
    const r = await stopSessionTask({ pid: 'proj_a', sid: 's1', taskId: 'ac5f8fb97ed891bb7' }, d);
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(d.stopTask).toHaveBeenCalledWith('ac5f8fb97ed891bb7');
  });

  it('⛔ 跨租户：会话当前回合属于别的项目 → 404，且不调 stopTask', async () => {
    const d = deps({ projectId: 'proj_b' });
    const r = await stopSessionTask({ pid: 'proj_a', sid: 's1', taskId: 't1' }, d);
    expect(r.status).toBe(404);
    expect(d.stopTask).not.toHaveBeenCalled();
  });

  it('没有在飞回合 → 404 NO_ACTIVE_TURN', async () => {
    const d = deps({ runId: null });
    expect((await stopSessionTask({ pid: 'proj_a', sid: 's1', taskId: 't1' }, d)).body.code).toBe('NO_ACTIVE_TURN');
  });

  it('非法 taskId → 400，不碰会话', async () => {
    const d = deps();
    expect((await stopSessionTask({ pid: 'proj_a', sid: 's1', taskId: '../x' }, d)).status).toBe(400);
    expect(d.stopTask).not.toHaveBeenCalled();
  });

  it('SDK 拒了（任务已结束）→ 404 TASK_NOT_STOPPABLE', async () => {
    const d = deps({ stopTask: vi.fn(async () => { throw new Error('Task not found'); }) });
    const r = await stopSessionTask({ pid: 'proj_a', sid: 's1', taskId: 't1' }, d);
    expect(r).toMatchObject({ status: 404, body: { code: 'TASK_NOT_STOPPABLE' } });
  });
});
