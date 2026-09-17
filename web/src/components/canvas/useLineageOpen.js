/**
 * 谱系收叠的展开集：用户点开的链尾（默认全收起，版面上只留现役版）。
 *
 * 2026-09-17 从 BoardCanvas 搬出（那个文件在行数棘轮顶格），顺带记一笔「点开 / 收起旧版」：
 * 「旧版很少被看」这件事此前没有任何数据，服务端日志里的 [lineage-toggle] 是唯一的量。
 * 上报 fire-and-forget，记不上不影响展开；只读视图（agent 的截图通道）不报。
 */
import { useState, useCallback } from 'react';
import { jsonRequest } from '../../lib/api.js';

export function useLineageOpen(projectId, { readOnly = false } = {}) {
  const [lineageOpen, setLineageOpen] = useState(() => new Set());
  const toggleLineage = useCallback((tipId, count = 0) => {
    const open = !lineageOpen.has(tipId);
    setLineageOpen((prev) => {
      const next = new Set(prev);
      if (open) next.add(tipId); else next.delete(tipId);
      return next;
    });
    if (projectId && !readOnly) {
      jsonRequest('POST', `/api/projects/${projectId}/board/lineage-toggle`, { tip: String(tipId), count, open })
        .catch(() => { /* 计数丢一笔无所谓 */ });
    }
  }, [lineageOpen, projectId, readOnly]);
  return [lineageOpen, toggleLineage];
}
