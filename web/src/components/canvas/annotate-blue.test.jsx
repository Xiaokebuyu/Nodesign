// @vitest-environment happy-dom
// 标注一律落蓝字（09-18）：发给 agent、攒着、留在画布三条都在画布上留一段蓝字 + 关于线；
// 说给角色的不落（服务端已落用户板书），对整块画布说的没有目标可连也不落。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

let props;
vi.mock('./AnnotatePopover.jsx', () => ({ default: (p) => { props = p; return null; } }));
vi.mock('../../lib/role-target.js', () => ({ soleRoleTarget: (ts) => (ts[0]?.role ? { who: '墨璃' } : null) }));
const { AnnotateHost } = await import('./annotate-host.jsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root;
afterEach(() => { act(() => root?.unmount()); });
const mount = (target) => {
  const keep = vi.fn(); const onAnnotate = vi.fn();
  root = createRoot(document.createElement('div'));
  act(() => root.render(<AnnotateHost annotate={{ x: 10, y: 20, target }} at={{ x: 0, y: 0 }} onClose={() => {}} onAnnotate={onAnnotate} keepAnnotation={keep} toWorld={(x, y) => ({ x, y })} />));
  return { keep, onAnnotate };
};

describe('标注落蓝字', () => {
  it('⭐ 发给 agent：落蓝字，也照常发', () => {
    const { keep, onAnnotate } = mount({ id: 'notes/板书/a.md', kind: 'chalk' });
    act(() => props.onSubmit('这里换个说法', {}));
    expect(keep).toHaveBeenCalledWith(['notes/板书/a.md'], { x: 10, y: 20 }, '这里换个说法');
    expect(onAnnotate).toHaveBeenCalledTimes(1);
  });

  it('⭐ 攒着：也落蓝字', () => {
    const { keep, onAnnotate } = mount({ id: 'site:落地页', kind: 'site' });
    act(() => props.onQueue('标题再大一点'));
    expect(keep).toHaveBeenCalledTimes(1);
    expect(onAnnotate.mock.calls[0][0]).toMatchObject({ queue: true });
  });

  it('说给角色的不落（服务端已落用户板书）；场外话给主持人的落', () => {
    const { keep } = mount({ id: 'notes/板书/b.md', kind: 'chalk', role: true });
    act(() => props.onSubmit('你好', { toMain: false }));
    expect(keep).not.toHaveBeenCalled();
    act(() => props.onSubmit('规则问一下', { toMain: true }));
    expect(keep).toHaveBeenCalledTimes(1);
  });

  it('对整块画布说的没有目标可连，不落', () => {
    const { keep } = mount({ id: 'canvas', kind: 'canvas' });
    act(() => props.onSubmit('整体再紧凑些', {}));
    expect(keep).not.toHaveBeenCalled();
  });
});

describe('标注撤销（09-18）', () => {
  it('⭐ 留在画布：弹带「撤销」的提示，点了撤掉那段蓝字', async () => {
    const { useGlobalStore } = await import('../../stores/globalStore.js');
    const undo = vi.fn();
    const keep = vi.fn(() => 'text:abc');
    root = createRoot(document.createElement('div'));
    act(() => root.render(<AnnotateHost annotate={{ x: 1, y: 2, target: { id: 'notes/板书/a.md' } }} at={{ x: 0, y: 0 }} onClose={() => {}} onAnnotate={() => {}} keepAnnotation={keep} undoAnnotation={undo} toWorld={(x, y) => ({ x, y })} />));
    act(() => props.onKeep('留个记号'));
    const toast = useGlobalStore.getState().toasts.at(-1);
    expect(toast.action.label).toBe('撤销');
    toast.action.onClick();
    expect(undo).toHaveBeenCalledWith('text:abc');
  });

  it('攒着：蓝字 id 跟着 note 交给队列那边（撤销在它的提示条上）', () => {
    const keep = vi.fn(() => 'text:q1');
    const onAnnotate = vi.fn();
    root = createRoot(document.createElement('div'));
    act(() => root.render(<AnnotateHost annotate={{ x: 1, y: 2, target: { id: 'site:x' } }} at={{ x: 0, y: 0 }} onClose={() => {}} onAnnotate={onAnnotate} keepAnnotation={keep} toWorld={(x, y) => ({ x, y })} />));
    act(() => props.onQueue('再大点'));
    expect(onAnnotate.mock.calls[0][0]).toMatchObject({ queue: true, note: 'text:q1' });
  });
});
