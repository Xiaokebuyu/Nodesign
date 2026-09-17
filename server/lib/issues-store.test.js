/**
 * 问题库同签名累加：计数之外，最近一次的现场（detail / 用户）也要留下。
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';

const { recordIssue, listIssues } = await import('./issues-store.js');

const tool = () => 'test_tool_' + crypto.randomBytes(3).toString('hex');
const find = (id) => listIssues({ status: 'all', limit: 10000 }).find((r) => r.id === id);

describe('recordIssue 同签名累加', () => {
  it('第二次的 detail 进 lastDetail，第一次的 detail 不变', () => {
    const t = tool();
    const a = recordIssue({ source: 'auto', toolName: t, summary: 'Bash 失败：Exit code 144', detail: 'Exit code 144', signature: 'sig-a' });
    const b = recordIssue({ source: 'auto', toolName: t, summary: 'Bash 失败：Exit code 144', detail: 'Exit code 144\n[cmd] sleep 999', signature: 'sig-a' });
    expect(b).toEqual({ id: a.id, count: 2 });
    const row = find(a.id);
    expect(row.detail).toBe('Exit code 144');
    expect(row.lastDetail).toBe('Exit code 144\n[cmd] sleep 999');
  });

  it('最近一次与第一次相同时不重复展示；没带 detail 的那次不抹掉上一次的', () => {
    const t = tool();
    const a = recordIssue({ source: 'auto', toolName: t, summary: 's', detail: 'same', signature: 'sig-b' });
    recordIssue({ source: 'auto', toolName: t, summary: 's', detail: 'same', signature: 'sig-b' });
    expect(find(a.id).lastDetail).toBe(null);
    recordIssue({ source: 'auto', toolName: t, summary: 's', detail: 'newer', signature: 'sig-b' });
    recordIssue({ source: 'auto', toolName: t, summary: 's', signature: 'sig-b' });
    expect(find(a.id).lastDetail).toBe('newer');
    expect(find(a.id).count).toBe(4);
  });

  it('首次没有 detail 的行，之后带上的 detail 补进 detail', () => {
    const t = tool();
    const a = recordIssue({ source: 'auto', toolName: t, summary: 's', signature: 'sig-c' });
    recordIssue({ source: 'auto', toolName: t, summary: 's', detail: 'later', signature: 'sig-c' });
    expect(find(a.id).detail).toBe('later');
  });

  it('用户记第一次，最近一次的设备与版本在 lastDetail 里', () => {
    const t = tool();
    const a = recordIssue({ source: 'desktop', toolName: t, summary: '桌面版启动失败：服务端意外退出（退出码 1）。', detail: '[桌面版 v0.1.12 win32 · 设备 A]', userId: 'u_a', signature: 'sig-d' });
    recordIssue({ source: 'desktop', toolName: t, summary: '桌面版启动失败：服务端意外退出（退出码 1）。', detail: '[桌面版 v0.1.43 win32 · 设备 B]', userId: 'u_b', signature: 'sig-d' });
    const row = find(a.id);
    expect(row.userId).toBe('u_a');
    expect(row.lastDetail).toContain('v0.1.43');
    expect(row.detail).toContain('v0.1.12');
  });
});
