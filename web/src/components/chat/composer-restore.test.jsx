// @vitest-environment happy-dom
/**
 * 回退或发送失败时，用户原话不丢（09-17，问题库 iss_mtxylgs4_xmmz）。
 *
 * 钉四件：
 *   ① 「回到此处」回退 / 分叉成功 → 那条的原文回到输入框；框里有别的字先问（覆盖 / 保留并接在后面，关掉弹框也不丢字）
 *   ② 发送失败 → 框空就放回；框里已经在写下一句就不动，提示里给一键放回
 *   ③ submit 清空后失败回调赶在重渲染前跑，也要能放回（textRef 同步置空）
 *   ④ 本页发出的附件随回退回托盘；回退成功提示里带「回退前的版本已保存（短哈希）」
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act, useState } from 'react';

const SID = '11111111-2222-4333-8444-555555555555';
const NEW_SID = '99999999-2222-4333-8444-555555555555';
const MSG_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const OPTIONS = [{ id: 'claude-sonnet-5[1m]', label: 'Sonnet 5', desc: '', brand: 'claude' }];

vi.mock('../../lib/api.js', async (orig) => {
  const mod = await orig();
  return {
    ...mod,
    Sessions: {
      ...mod.Sessions,
      model: vi.fn(async () => ({ model: OPTIONS[0].id, override: null, default: OPTIONS[0].id, options: OPTIONS })),
      rewind: vi.fn(),
      fork: vi.fn(async () => ({ sessionId: NEW_SID })),
    },
    Me: { ...mod.Me, models: vi.fn(async () => ({ options: OPTIONS, default: OPTIONS[0].id })) },
  };
});
const { Sessions } = await import('../../lib/api.js');
const { useGlobalStore } = await import('../../stores/globalStore.js');
const { default: ChatComposer } = await import('./ChatComposer.jsx');
const { default: UserMessage } = await import('./UserMessage.jsx');
const { useRewindEvents } = await import('../../routes/use-rewind-events.js');
const draft = await import('../../lib/composer-draft.js');
const { restoreToComposer, planRestore, joinDraft, originalTextOf, rememberSent, restoreAfterFailedSend } = draft;

let host; let root; let trayRef;
function Harness({ message, onSend }) {
  const [inputs, setInputs] = useState([]);
  trayRef = inputs;
  useRewindEvents({
    projectId: 'proj_a', currentSessionId: null, setMessages: () => {}, sessionIdRef: { current: SID },
    setCurrentSessionId: () => {}, updateProject: () => {}, setInputs,
  });
  return (
    <>
      {message && <UserMessage message={message} projectId="proj_a" sessionId={SID} />}
      <ChatComposer onSend={onSend} trayItems={inputs} projectId="proj_a" sessionId={SID} />
    </>
  );
}
async function render(props = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root.render(<Harness {...props} />); });
  await act(async () => { await Promise.resolve(); });
  return host;
}
const box = () => host.querySelector('textarea');
async function type(value) {
  const el = box();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
const buttons = () => [...document.body.querySelectorAll('button')];
const buttonNamed = (name) => buttons().find((b) => b.textContent.trim() === name);
const toasts = () => useGlobalStore.getState().toasts.map((x) => x.msg);
async function openRewind({ onlyConversation = false, fork = false } = {}) {
  await act(async () => { host.querySelector('[style*="flex-end"]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
  await act(async () => { buttonNamed('回到此处').click(); });
  const pick = (title) => [...document.body.querySelectorAll('div')].find((d) => d.textContent === title);
  if (onlyConversation) await act(async () => { pick('只回退对话').click(); });
  if (fork) await act(async () => { pick('留着，另开一条分支').click(); });
  await act(async () => { buttonNamed(fork ? '分叉' : '回退').click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(() => {
  useGlobalStore.setState({ toasts: [], confirmDialog: null, modelPref: OPTIONS[0].id });
  Sessions.rewind.mockResolvedValue({ canRewind: true, filesChanged: [], conversationTruncated: true, removedEntries: 3, preRewindCommit: 'abc1234def5678' });
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.clearAllMocks(); });

describe('决定怎么放（纯函数）', () => {
  it('框空放进去；框里就是这段不动；有别的字按 mode 分', () => {
    expect(planRestore('', '原话', 'ask')).toEqual({ outcome: 'filled', next: '原话' });
    expect(planRestore('原话\n', '原话', 'ask').outcome).toBe('same');
    expect(planRestore('新的', '原话', 'ask')).toEqual({ outcome: 'asked', next: null });
    expect(planRestore('新的', '原话', 'fill-if-empty')).toEqual({ outcome: 'occupied', next: null });
    expect(planRestore('新的  ', '原话', 'append')).toEqual({ outcome: 'appended', next: '新的\n\n原话' });
    expect(planRestore('新的', '   ', 'ask').outcome).toBe('same');   // 没有原文可放（只发了附件）
    expect(joinDraft('', '原话')).toBe('原话');
  });

  it('hydrate 回来的正文：摘掉 <system> 块、附件说明和「只发了附件」占位', () => {
    const content = '<system>用户有 2 处直接编辑。</system>\n\n把标题改大\n\n第二段也改\n\n'
      + '[已直接附上 1 张参考图：a.png —— 你可以直接 vision 看，不需要再 Read]\n\n可用素材（用 Read 工具读取，路径相对 cwd）：\n- assets/b.pdf（b.pdf）';
    expect(originalTextOf({ id: 'x-1', content })).toBe('把标题改大\n\n第二段也改');
    expect(originalTextOf({ id: 'x-2', content: '[用户只发了附件，没有附带文字。先看附件再问他想拿它做什么]\n\n[已直接附上 1 张参考图：a.png]' })).toBe('');
    expect(originalTextOf({ id: 'x-3', content: '（附件：a.png、b.png）' })).toBe('');
  });

  it('本页发出去的那条以记下的原文为准（不从气泡反推）', () => {
    rememberSent('x-4', { text: '【画布标注】板书「a」：原话', attachments: [{ path: 'assets/a.png', previewUrl: 'blob:1' }] });
    expect(originalTextOf({ id: 'x-4', content: '（附件：a.png）' })).toBe('【画布标注】板书「a」：原话');
    expect(draft.recallSent('x-4').attachments).toEqual([{ path: 'assets/a.png' }]);   // 回收过的预览地址不带
  });
});

describe('输入框接「放回来」', () => {
  it('没有输入框在听 → outcome 为 null', () => {
    expect(restoreToComposer('原话')).toBeNull();
  });

  it('⭐ 框空：放进去；框里有别的字（发送失败那种）：不动', async () => {
    await render();
    let outcome;
    await act(async () => { outcome = restoreToComposer('原话'); });
    expect(outcome).toBe('filled');
    expect(box().value).toBe('原话');
    await type('我在写下一句');
    await act(async () => { outcome = restoreToComposer('原话二'); });
    expect(outcome).toBe('occupied');
    expect(box().value).toBe('我在写下一句');
    await act(async () => { outcome = restoreToComposer('原话二', { mode: 'append' }); });
    expect(outcome).toBe('appended');
    expect(box().value).toBe('我在写下一句\n\n原话二');
  });

  it('⭐ 回退那种（ask）：框里有字先问；覆盖 → 换成原文，关掉弹框 → 保留并接在后面', async () => {
    await render();
    await type('草稿');
    let outcome;
    await act(async () => { outcome = restoreToComposer('原话', { mode: 'ask' }); });
    expect(outcome).toBe('asked');
    expect(box().value).toBe('草稿');   // 答之前一个字不动
    expect(useGlobalStore.getState().confirmDialog?.confirmLabel).toBe('用原文覆盖');
    await act(async () => { useGlobalStore.getState().closeConfirmDialog(true); });
    expect(box().value).toBe('原话');

    await type('又一版草稿');
    await act(async () => { restoreToComposer('原话', { mode: 'ask' }); });
    await act(async () => { useGlobalStore.getState().closeConfirmDialog(false); });   // Esc / 点遮罩 / 点「保留」
    expect(box().value).toBe('又一版草稿\n\n原话');
  });

  it('⭐ submit 清空后，失败回调赶在重渲染之前跑，也放得回来', async () => {
    let outcome = 'not-run';
    // 同步拒绝：catch 排在 React 重渲染之前的微任务里
    const onSend = (text) => Promise.reject(new Error('offline')).catch(() => { outcome = restoreToComposer(text); });
    await render({ onSend });
    await type('这句没发出去');
    await act(async () => { box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(outcome).toBe('filled');
    expect(box().value).toBe('这句没发出去');
  });
});

describe('发送失败的提示（restoreAfterFailedSend）', () => {
  it('⭐ 框空：放回并在提示里说；框里有字：提示「上一条没发出去」+ 一键放回（接在后面）', async () => {
    await render();
    let t1;
    await act(async () => { t1 = restoreAfterFailedSend('第一句', '发送失败：网络错误'); });
    expect(t1.msg).toBe('发送失败：网络错误（原文已放回输入框）');
    expect(t1.opts).toBeNull();
    expect(box().value).toBe('第一句');

    await type('第二句');
    let t2;
    await act(async () => { t2 = restoreAfterFailedSend('第一句改过', '额度已用完'); });
    expect(t2.msg).toBe('额度已用完（上一条没发出去）');
    expect(box().value).toBe('第二句');
    expect(t2.opts.action.label).toBe('放回输入框');
    await act(async () => { t2.opts.action.onClick(); });
    expect(box().value).toBe('第二句\n\n第一句改过');
  });

  it('首页带来的附件（location.state）失败时回托盘，同一个 path 不重复加', async () => {
    await render();
    const att = [{ type: 'asset', path: 'assets/ref.png', name: 'ref.png', mime: 'image/png' }];
    await act(async () => { restoreAfterFailedSend('', '发送失败：x', { attachments: att }); });
    await act(async () => { restoreAfterFailedSend('', '发送失败：x', { attachments: att }); });
    expect(trayRef.map((i) => i.path)).toEqual(['assets/ref.png']);
    expect(trayRef[0].id).toBeTruthy();
  });
});

describe('「回到此处」之后', () => {
  const message = { id: MSG_ID, role: 'user', content: '<system>x</system>\n\n把第三章重写\n\n[已直接附上 1 张参考图：ref.png —— 你可以直接 vision 看，不需要再 Read]' };

  it('⭐ 原地回退：原文回到输入框，本页发出的附件回托盘；提示里说原文放回了、回退前的版本已保存（短哈希）', async () => {
    rememberSent(MSG_ID, { text: '把第三章重写', attachments: [{ type: 'asset', path: 'assets/ref.png', name: 'ref.png' }] });
    await render({ message });
    await openRewind();
    expect(Sessions.rewind).toHaveBeenCalledWith('proj_a', SID, MSG_ID, { files: true, truncateConversation: true });
    expect(box().value).toBe('把第三章重写');
    expect(trayRef.map((i) => i.path)).toEqual(['assets/ref.png']);
    expect(toasts().at(-1)).toBe('已回退对话（没有文件改动要撤销），原文已放回输入框；回退前的版本已保存（abc1234）');
  });

  it('刷新过页面（没有记下的那份）：从正文里摘原话；只回对话不报「版本已保存」', async () => {
    Sessions.rewind.mockResolvedValue({ canRewind: true, filesChanged: [], conversationTruncated: true, removedEntries: 2 });
    await render({ message: { ...message, id: 'bbbbbbbb-1111-4222-8333-444444444444' } });
    await openRewind({ onlyConversation: true });
    expect(box().value).toBe('把第三章重写');
    expect(toasts().at(-1)).toBe('已回退对话，产物留在原处，原文已放回输入框');
  });

  it('⭐ 输入框里有字：先问；关掉弹框 = 保留并接在后面，提示里不说「已放回」', async () => {
    await render({ message: { ...message, id: 'cccccccc-1111-4222-8333-444444444444' } });
    await type('我正在写的');
    await openRewind();
    expect(box().value).toBe('我正在写的');
    await act(async () => { useGlobalStore.getState().closeConfirmDialog(false); });
    expect(box().value).toBe('我正在写的\n\n把第三章重写');
    expect(toasts().at(-1)).not.toContain('原文已放回');
  });

  it('SDK 说此处回不了：不动输入框', async () => {
    Sessions.rewind.mockResolvedValue({ canRewind: false, error: '没有检查点' });
    await render({ message: { ...message, id: 'dddddddd-1111-4222-8333-444444444444' } });
    await openRewind();
    expect(box().value).toBe('');
  });

  it('对话没截成（转录里找不到这条）：气泡还在，不往输入框里再放一份', async () => {
    Sessions.rewind.mockResolvedValue({ canRewind: true, filesChanged: [], conversationTruncated: false, preRewindCommit: 'abc1234def5678' });
    await render({ message: { ...message, id: 'dddddddd-2222-4222-8333-444444444444' } });
    await openRewind();
    expect(box().value).toBe('');
    expect(toasts().at(-1)).toBe('已回退对话（没有文件改动要撤销）；回退前的版本已保存（abc1234）');
  });

  it('回退前的版本没保存全：另给一条提示说原因', async () => {
    Sessions.rewind.mockResolvedValue({ canRewind: true, filesChanged: [], conversationTruncated: true, preRewindNote: '文件夹不是 git 仓库，文件夹里回退前的内容没有保存' });
    await render({ message: { ...message, id: 'eeeeeeee-1111-4222-8333-444444444444' } });
    await openRewind();
    expect(toasts()).toContain('回退前的版本没有完整保存：文件夹不是 git 仓库，文件夹里回退前的内容没有保存');
  });

  it('⭐ 分叉带产物：回退记给新分支（noteSessionId），原文放回输入框', async () => {
    Sessions.rewind.mockResolvedValue({ canRewind: true, filesChanged: [], conversationTruncated: false, preRewindCommit: 'fedcba9876' });
    const forked = vi.fn();
    window.addEventListener('nd-session-forked', forked);
    await render({ message: { ...message, id: 'ffffffff-1111-4222-8333-444444444444' } });
    await openRewind({ fork: true });
    window.removeEventListener('nd-session-forked', forked);
    expect(Sessions.fork).toHaveBeenCalledWith('proj_a', SID, { upToMessageId: 'ffffffff-1111-4222-8333-444444444444' });
    expect(Sessions.rewind).toHaveBeenCalledWith('proj_a', SID, 'ffffffff-1111-4222-8333-444444444444', { files: true, truncateConversation: false, noteSessionId: NEW_SID });
    expect(forked).toHaveBeenCalled();
    expect(box().value).toBe('把第三章重写');
    expect(toasts().at(-1)).toBe('已开新分支，产物也回到了那时的样子，原文已放回输入框；回退前的版本已保存（fedcba9）');
  });
});
