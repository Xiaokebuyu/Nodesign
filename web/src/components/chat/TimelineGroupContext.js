/**
 * TimelineGroupContext —— 让 TimelineNode 知道自己在 group 里的位置。
 *
 * 修复 bug：每个 TimelineNode 自己画 top:0/bottom:0 全长竖线，最后一个
 * （done）节点会让线"溢出"icon 之下。Group 内第一节点同理上方溢出。
 *
 * 用 Context 而不是 prop drilling：Message 组件内部 render TimelineNode，
 * TimelineGroup 不直接接触 TimelineNode，prop 链太长。Context 一行读取。
 *
 * Position：
 *   - 'first'：竖线从 icon center 开始向下（顶部不画）
 *   - 'last'：竖线到 icon center 结束（底部不画）
 *   - 'only'：单节点，根本不画线
 *   - 'middle' 或 null（默认）：top:0 to bottom:0 全长（保持当前行为）
 */

import { createContext, useContext } from 'react';

const TimelinePositionContext = createContext(null);

export const TimelinePositionProvider = TimelinePositionContext.Provider;

export function useTimelinePosition() {
  return useContext(TimelinePositionContext);
}
