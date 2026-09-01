/**
 * board-labels.js —— 画布上那几行派生的字（2026-09-01 从 BoardCanvas 拆出）
 *
 * 三个小 memo：顶带摘要、会话标题表、文件夹标题表。共同点是它们都只是**把已有
 * 数据换个形状给渲染用**，没有交互、没有状态、跟画布的几何和手势毫无关系。
 * 拆出来的直接原因是行数棘轮（叠纸刀 5 加翻页器和目录时顶到 2128），但它们本来
 * 就不该跟相机、拖拽、落位挤在同一个文件里。
 */
import { useMemo } from 'react';

/** 顶带摘要（08-24 记忆体系改版：记忆/风格卡退役 —— 记忆住 记忆/、风格并进
 *  根 CLAUDE.md，都是画布上的普通文件；这里只剩项目档案与文件两张） */
export function useBandSummaries(guideText, fileCount) {
  return useMemo(() => ({
    guide: guideText.trim() ? guideText.trim().slice(0, 60) : '还没写，点开写项目档案',
    files: fileCount == null ? '' : (fileCount ? `${fileCount} 个文件` : '还没有文件，点开上传'),
  }), [guideText, fileCount]);
}

/** 会话 id → 显示标题（自定义 > 自动标题 > 摘要 > 第一句话） */
export function useSessionTitles(sessions) {
  return useMemo(() => {
    const map = new Map();
    for (const s of sessions) {
      map.set(s.sessionId || s.id, s.customTitle || s.title || s.summary || s.firstPrompt || '未命名 deck');
    }
    return map;
  }, [sessions]);
}

/** 文件夹标题：zone id 就是工作区相对路径，末段即标题 */
export function useTaskTitles(tasks) {
  return useMemo(
    () => new Map(tasks.filter(t => t.id).map(t => [t.id, t.title])), [tasks]);
}
