/**
 * useBlackboardMode —— 黑板模式开关 + 镜头跟随（2026-08-23）
 *
 * 开关存项目级 ui-config.json（blackboard_mode），服务端 UserPromptSubmit 读同一份
 * 决定给 agent 注入「主体内容落画布」的硬规则。前端这边：
 *   - 工具栏按钮显示/切换
 *   - 开着时，agent 落一张草图（board.focus 事件）镜头飞过去框住它（maxZoom 1，
 *     不放大到超过 100%；小图也不会贴脸）。关着不动镜头 —— 不劫持。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { SessionConfig } from '../../lib/api.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { useViewpointReport } from './useViewpointReport.js';
import { eyeParams, useEyeMode } from './eye-mode.js';

export function useBlackboardMode({ projectId, focusRequest, camRef }) {
  // 默认开（2026-08-24 用户拍板）；配置里显式关过的读回 false
  const [on, setOn] = useState(true);
  useEffect(() => {
    let alive = true;
    if (!projectId) return undefined;
    SessionConfig.read(projectId).then((r) => {
      if (alive && r?.config && typeof r.config.blackboard_mode === 'boolean') setOn(r.config.blackboard_mode);
    }).catch(() => {});
    return () => { alive = false; };
  }, [projectId]);

  const toggle = useCallback(() => {
    setOn((prev) => {
      const next = !prev;
      SessionConfig.patch(projectId, { blackboard_mode: next }).catch(() => {});
      return next;
    });
  }, [projectId]);

  // 新板书/新草图可感知：
  //   - 黑板模式开着 & 不是 soft（整张草图）→ 镜头飞过去框住
  //   - 其余情况：在视口里就不打扰；在视口外 → 一条带「看一眼」的提示，点了再飞（不劫持镜头）
  const seen = useRef(0);
  useEffect(() => {
    if (eyeParams()) return;   // 眼睛页：不飞、不弹提示（否则截图里会有 toast / 镜头跑偏）
    if (!focusRequest?.rect || !focusRequest.at || focusRequest.at === seen.current) return;
    seen.current = focusRequest.at;
    const r = focusRequest.rect;
    const box = { x: r.x - 40, y: r.y - 40, w: r.w + 80, h: r.h + 80 };
    const fly = () => camRef.current?.flyToBox?.(box, { force: true, maxZoom: 1 });
    const cam = camRef.current?.cam; const vp = camRef.current?.viewport;
    let inside = false;
    if (cam && vp?.w) {
      const z = cam.z || 1;
      const view = { x: -cam.x, y: -cam.y, w: vp.w / z, h: vp.h / z };
      inside = r.x >= view.x && r.y >= view.y && r.x + r.w <= view.x + view.w && r.y + r.h <= view.y + view.h;
    }
    if (on && !focusRequest.soft) { fly(); return; }
    if (inside) return;
    const what = focusRequest.chalk ? '写了一条板书' : '画了一张草图';
    useGlobalStore.getState().showToast(`agent 在画布上${what}（视野之外）`, 'info', { action: { label: '看一眼', onClick: fly } });
  }, [on, focusRequest, camRef]);

  return { blackboardMode: on, toggleBlackboard: toggle };
}

/**
 * 黑板三件一起挂（BoardCanvas 行数棘轮逼出来的收口，语义不变）：
 * 视点上报（眼睛模式不报）+ 眼睛模式 + 黑板模式开关/跟随。
 */
export function useBlackboardWiring({ projectId, cam, viewport, winDir, openWindow, selectedIds, occupied, camRef, positionedRef, focusRequest }) {
  const eye = eyeParams();
  useViewpointReport({
    projectId, cam, viewport, layer: winDir || '',
    openWindow: winDir ? `folder:${winDir}` : openWindow, selectedIds, occupied, enabled: !eye,
  });
  useEyeMode({ eye, camRef, positionedRef });
  return useBlackboardMode({ projectId, focusRequest, camRef });
}
