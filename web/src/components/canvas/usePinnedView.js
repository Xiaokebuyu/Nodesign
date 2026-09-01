/**
 * usePinnedView —— 钉住视区的开关（2026-09-01 叠纸刀 6）
 *
 * 站主拍板「固定操作我们或许可以分发给所有平台」，所以这里不分设备档。
 *
 * 钉住之后：镜头守着当前这一摞（agent 换页、写在哪一页都不会把用户甩到别处），
 * 触屏上横滑换摞、竖滑翻页。⚠️ **钉住不是不许动** —— 用户照旧能缩放凑近看，
 * 只是镜头不会自己跑掉。
 *
 * 状态存项目级 `ui-config.json` 的 `pin_view`（重开页面还在），并且 agent 拨得动
 * （`edit_board{op:'pin_view'}` → ui.pin_view → 窗口事件）。跟 08-25 的「改板书」
 * 开关一模一样的路子 —— 演出开场 agent 可以替用户钉上，用户不用先学会这颗按钮。
 */
import { useState, useEffect, useCallback } from 'react';
import { SessionConfig } from '../../lib/api.js';

export function usePinnedView({ projectId }) {
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    let alive = true;
    if (projectId) {
      SessionConfig.read(projectId).then((r) => {
        if (alive && typeof r?.config?.pin_view === 'boolean') setPinned(r.config.pin_view);
      }).catch(() => {});
    }
    const onAgent = (e) => setPinned(!!e.detail?.on);
    window.addEventListener('nd:pin-view', onAgent);
    return () => { alive = false; window.removeEventListener('nd:pin-view', onAgent); };
  }, [projectId]);

  const togglePin = useCallback(() => {
    setPinned((v) => {
      SessionConfig.patch(projectId, { pin_view: !v }).catch(() => {});
      return !v;
    });
  }, [projectId]);

  return { pinned, togglePin };
}
