// @vitest-environment happy-dom
/**
 * 子代理时间轴行上的「停止」（09-13）：跑着才有、完成了没有；点了发单停请求，不是停整轮。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

vi.mock('../../lib/api.js', async (orig) => {
  const mod = await orig();
  return { ...mod, Turn: { ...mod.Turn, stopTask: vi.fn(async () => ({ ok: true })), cancel: vi.fn() } };
});
const { Turn } = await import('../../lib/api.js');
const { default: Message } = await import('./Message.jsx');

let host; let root;
const agentMsg = (taskStatus) => ({
  role: 'tool', id: 'toolu_1', toolName: 'Agent', status: 'running',
  toolInput: { subagent_type: 'vision-checker', description: '逐页检查', prompt: '看一遍' },
  taskId: 'ac5f8fb97ed891bb7', taskStatus, agentType: 'vision-checker', taskDescription: '逐页检查',
});
function render(message) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root.render(<Message message={message} projectId="proj_a" sessionId="sess-1" />); });
  return host;
}
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.clearAllMocks(); });

describe('子代理停止按钮', () => {
  it('⭐ 跑着时有按钮，点了按 taskId 单停（不调整轮 cancel）', async () => {
    const el = render(agentMsg('running'));
    const btn = el.querySelector('[data-testid="task-stop"]');
    expect(btn).not.toBeNull();
    await act(async () => { btn.click(); });
    expect(Turn.stopTask).toHaveBeenCalledWith({ pid: 'proj_a', sid: 'sess-1', taskId: 'ac5f8fb97ed891bb7' });
    expect(Turn.cancel).not.toHaveBeenCalled();
  });

  it('完成 / 已停止后没有按钮', () => {
    expect(render(agentMsg('completed')).querySelector('[data-testid="task-stop"]')).toBeNull();
    act(() => root.unmount()); host.remove();
    expect(render(agentMsg('stopped')).querySelector('[data-testid="task-stop"]')).toBeNull();
  });

  it('还没拿到 taskId（task_started 未到）时不出按钮', () => {
    expect(render({ ...agentMsg('running'), taskId: undefined }).querySelector('[data-testid="task-stop"]')).toBeNull();
  });
});
