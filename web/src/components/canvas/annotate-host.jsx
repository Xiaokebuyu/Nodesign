import { useMemo } from 'react';
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
export function AnnotateHost({ annotate, at, onClose, onAnnotate, keepAnnotation, toWorld }) {
  const targets = annotate.targets?.length ? annotate.targets : [annotate.target];
  return (
    <AnnotatePopover
      x={at.x} y={at.y}
      target={annotate.target}
      // 这批标注是不是全指着同一个常驻角色 —— 是的话这句话**直达它**，
      // 不经过主 agent。判据跟真正发送时走的是同一个函数（lib/role-target.js），
      // 不能在这儿另写一份：文案说"说给墨璃"而实际发给了主控，比不显示更糟。
      roleTarget={soleRoleTarget(targets)}
      onClose={onClose}
      onSubmit={(text, opts) => onAnnotate?.({ target: annotate.target, targets: annotate.targets, text, toMain: !!opts?.toMain })}
      // 攒着：同一条回调，多一个 queue 标记 —— 落点在 ProjectWorkspace
      // （pending-changes buffer 和那条浮钮都住在那儿）
      onQueue={(text) => onAnnotate?.({ target: annotate.target, targets: annotate.targets, text, queue: true })}
      onKeep={(text) => keepAnnotation(targets.map(t => t.id), toWorld?.(annotate.x, annotate.y), text)}
    />
  );
}
