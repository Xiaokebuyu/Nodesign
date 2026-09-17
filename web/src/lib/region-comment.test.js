import { describe, it, expect, vi } from 'vitest';

vi.mock('./api.js', () => ({ PendingChanges: { regionComment: vi.fn(async () => ({ ok: true })) } }));
vi.mock('../stores/globalStore.js', () => ({ useGlobalStore: { getState: () => ({ openChatDock: () => {} }) } }));
const { PendingChanges } = await import('./api.js');
const { makeRegionCommentHandler, waitRegionShots } = await import('./region-comment.js');

const base = { region: { x: 1, y: 2, w: 30, h: 40 }, viewport: { width: 1366, height: 768 }, container: null, elements: [], path: 'index.html' };

describe('圈选评论', () => {
  it('攒着：先登记进 comments（浮钮计数），POST 进 buffer，不起轮', async () => {
    let comments = [];
    const setComments = (f) => { comments = f(comments); };
    const handleSend = vi.fn();
    const h = makeRegionCommentHandler({ projectId: 'p1', setComments, showToast: vi.fn(), handleSend });
    await h({ ...base, text: '这块太挤', queue: true });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ kind: 'region-comment', path: 'index.html', status: 'open', anchor: null });
    expect(PendingChanges.regionComment).toHaveBeenCalledWith('p1', expect.objectContaining({ id: comments[0].id, path: 'index.html' }));
    expect(handleSend).not.toHaveBeenCalled();
  });
  it('立刻发：POST 完直接起一轮，消息只写一句指路', async () => {
    const handleSend = vi.fn();
    const h = makeRegionCommentHandler({ projectId: 'p1', setComments: vi.fn(), showToast: vi.fn(), handleSend });
    await h({ ...base, text: '' });
    expect(handleSend).toHaveBeenCalledTimes(1);
    expect(handleSend.mock.calls[0][0]).toMatch(/index\.html 上圈了一块/);
  });
  it('攒着但 POST 失败：登记撤回并提示', async () => {
    PendingChanges.regionComment.mockRejectedValueOnce(new Error('boom'));
    let comments = [];
    const setComments = (f) => { comments = f(comments); };
    const showToast = vi.fn();
    const h = makeRegionCommentHandler({ projectId: 'p1', setComments, showToast, handleSend: vi.fn() });
    await h({ ...base, text: 'x', queue: true });
    expect(comments).toHaveLength(0);
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/没记下来/), 'error');
  });

  it('攒着后立刻发（09-14 竞态）：发送要等在飞的截图写进 buffer', async () => {
    let finish;
    PendingChanges.regionComment.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
    const h = makeRegionCommentHandler({ projectId: 'p2', setComments: vi.fn(), showToast: vi.fn(), handleSend: vi.fn() });
    const queued = h({ ...base, text: '攒一块', queue: true });
    const showToast = vi.fn();
    let sent = false;
    const waiting = waitRegionShots('p2', showToast).then(() => { sent = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toBe(false);                       // 截图没回来之前不起轮
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/1 张圈选截图在生成/), 'info');
    finish({ ok: true });
    await queued; await waiting;
    expect(sent).toBe(true);
    // 落地之后再发不用等，也不提示
    const again = vi.fn();
    await waitRegionShots('p2', again);
    expect(again).not.toHaveBeenCalled();
  });
  it('截图卡死也不无限等：封顶后照发', async () => {
    vi.useFakeTimers();
    PendingChanges.regionComment.mockImplementationOnce(() => new Promise(() => {}));
    const h = makeRegionCommentHandler({ projectId: 'p3', setComments: vi.fn(), showToast: vi.fn(), handleSend: vi.fn() });
    h({ ...base, text: 'x', queue: true });
    let sent = false;
    const waiting = waitRegionShots('p3').then(() => { sent = true; });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(sent).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await waiting;
    expect(sent).toBe(true);
    vi.useRealTimers();
  });
});
