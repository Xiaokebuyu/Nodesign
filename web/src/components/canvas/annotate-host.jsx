import { useCallback, useMemo } from 'react';
import { Assets } from '../../lib/api.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import AnnotatePopover from './AnnotatePopover.jsx';
import { soleRoleTarget } from '../../lib/role-target.js';

/**
 * 标注浮层的落点（2026-09-12 站主定：跟被标注的东西相对固定，不跟用户的画面跑）。
 * 各处 setAnnotate 给的是屏幕坐标（六个入口不用改）：打开那一刻换成世界坐标记住，
 * 之后每次相机变化再换算回屏幕 —— 浮层跟着卡走。对整块画布说的（target.kind === 'canvas'）
 * 没有目标可跟，仍钉屏幕。
 */
export function useAnnotateScreenPos(annotate, camApiRef) {
  const world = useMemo(
    () => (annotate && annotate.target?.kind !== 'canvas' ? camApiRef.current?.toWorld?.(annotate.x, annotate.y) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [annotate],
  );
  if (!annotate) return null;
  if (world && camApiRef.current?.toScreen) return camApiRef.current.toScreen(world.x, world.y);
  return { x: annotate.x, y: annotate.y };
}

/** 浮层本体的装配（从 BoardCanvas 拆出，行数棘轮） */
export function AnnotateHost({ annotate, at, onClose, onAnnotate, keepAnnotation, undoAnnotation, toWorld }) {
  const targets = annotate.targets?.length ? annotate.targets : [annotate.target];
  const role = soleRoleTarget(targets);
  /**
   * 标注一律在画布上留一段蓝字 + 连到目标的「关于」线（09-18 补齐板书树设计稿第九节：蓝＝用户说的话）。
   * 原来只有「留在画布」这条落字，「发给 agent」「攒着」只进对话，板上什么都不剩 —— 站主在 exp 上
   * 标注完找不到蓝字。agent 把这句意见改写进那张板书之后，服务端把蓝字一并归档撤下
   * （server/lib/chalk-annotations.js）。说给角色的那条不落：服务端已经把原话落成一条用户板书（user-chalk-echo）。
   */
  const leave = (text, toRole = false) => {
    if (toRole || annotate.target?.kind === 'canvas') return null;
    return keepAnnotation(targets.map(t => t.id), toWorld?.(annotate.x, annotate.y), text);
  };
  return (
    <AnnotatePopover
      x={at.x} y={at.y}
      target={annotate.target}
      // 这批标注是不是全指着同一个常驻角色 —— 是的话这句话**直达它**，
      // 不经过主 agent。判据跟真正发送时走的是同一个函数（lib/role-target.js），
      // 不能在这儿另写一份：文案说"说给墨璃"而实际发给了主控，比不显示更糟。
      roleTarget={role}
      onClose={onClose}
      onSubmit={(text, opts) => {
        leave(text, !!role && !opts?.toMain);
        onAnnotate?.({ target: annotate.target, targets: annotate.targets, text, toMain: !!opts?.toMain });
      }}
      // 攒着：同一条回调，多一个 queue 标记 —— 落点在 ProjectWorkspace
      // （pending-changes buffer 和那条浮钮都住在那儿）
      // 攒着的撤销在 ProjectWorkspace 的提示条上（它握着待发队列）：蓝字 id 跟着 note 带过去
      onQueue={(text) => { const note = leave(text); onAnnotate?.({ target: annotate.target, targets: annotate.targets, text, queue: true, note }); }}
      onKeep={(text) => {
        const note = keepAnnotation(targets.map(t => t.id), toWorld?.(annotate.x, annotate.y), text);
        // 撤销（09-18）：只留在画布的这条完全可逆。发给 agent 的那条已经起了一轮，撤不回（蓝字照常可以删）
        if (note) useGlobalStore.getState().showToast('标注留在画布上了', 'info', { action: { label: '撤销', onClick: () => undoAnnotation?.(note) } });
      }}
    />
  );
}

/**
 * 标注落在画布上的那段蓝字：落下、撤销（09-18 从 BoardCanvas 搬来，行数棘轮 + 撤销要一起放）。
 */
export function useAnnotationInk({ rectOfId, handleCreateText, projectId, setBindings, removeLayoutEntry }) {
  /**
   * 标注的第二个出口：**留在画布** —— 一段文字 + 一条 `annotates` 关系。
   *
   * **批注是关系不是自由文字**：光写一段话飘在旁边，过两天就没人知道它在说谁；
   * 存成关系之后，被批注的东西一移动，批注跟着走，线自己重画。
   *
   * 2026-08-13 从工具栏的「标注(C)」搬到这儿 —— 那个工具连同它的 commentDraft
   * 输入框一起删了，两条标注路（留在画布 / 发给 agent）收成同一张浮层的两个
   * 按钮，见 AnnotatePopover 的说明。
   *
   * 落点**贴着目标右边**，不落在光标处：光标可能正压在卡上（右键菜单从卡上
   * 弹、标注按钮就长在卡的右上角），落在那儿等于把一段字盖在产物脸上。
   *
   * 批量标注（框选之后右键）落**一段字 + N 条线**：一句话说的是这一组，
   * 抄成 N 段一样的字是把同一件事记 N 遍，改一处还得改 N 处。
   */
  const keepAnnotation = useCallback((targetIds, fallbackAt, text) => {
    const t = (text || '').trim();
    const ids = (Array.isArray(targetIds) ? targetIds : [targetIds]).filter(Boolean);
    if (!t || !ids.length) return null;
    const rects = ids.map(rectOfId).filter(Boolean);
    // 落在整组的右边（取所有目标的最右沿、最上沿）
    const at = rects.length
      ? { x: Math.max(...rects.map(r => r.x + r.w)) + 24, y: Math.min(...rects.map(r => r.y)) }
      : fallbackAt;
    if (!at) return null;
    const noteId = handleCreateText(t, at, { color: 'blue' });   // 蓝＝用户说的话（09-17 板书树，墨是 agent 的）
    if (!noteId) return null;
    // 文字落好了才连线 —— 端点必须真实存在，否则画布上留一条通向虚空的线
    const stamp = `${Date.now().toString(36)}${Math.floor(performance.now() % 1000)}`;
    const links = {};
    ids.forEach((id, i) => { links[`b:${stamp}${i}`] = { type: 'annotates', from: noteId, to: id, by: 'user' }; });
    setBindings(prev => ({ ...prev, ...links }));
    Assets.patchBoard(projectId, { bindings: links }).catch(() => {});
    return noteId;
  }, [rectOfId, handleCreateText, projectId, setBindings]);

  /**
   * 撤销一条标注（09-18 站主「给标注加一个撤销功能」）：蓝字删掉，连着它的线本地先摘（服务端删物件时
   * 端点级联会把线一起清掉）。攒着的那条从待发队列里拿掉是 ProjectWorkspace 的事（它握着队列）。
   */
  const undoAnnotation = useCallback((noteId) => {
    if (!noteId) return;
    removeLayoutEntry(noteId);
    setBindings(prev => Object.fromEntries(Object.entries(prev).filter(([, b]) => b?.from !== noteId)));
  }, [removeLayoutEntry, setBindings]);

  return { keepAnnotation, undoAnnotation };
}
