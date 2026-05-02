import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { loadLayout, saveLayout, clearLayout, mergeLayouts } from '../../lib/panel-persistence.js';

/**
 * PanelManager — FloatingPanel 全局状态 + 持久化 + Context
 *
 * Canvas 焕新升级 F1.2（2026-05-02）。
 *
 * 职责：
 *   - 维护所有 FloatingPanel 的 { position, size, visible, zIndex } state
 *   - 自动持久化到 localStorage（per-project，切 session 不重置）
 *   - 提供 React Context 给 FloatingPanel 读 + 写
 *   - 管理 z-index 自动置顶（点 panel 升到最前）
 *   - 提供 reset layout 入口
 *
 * 用法：
 *
 *   <PanelManagerProvider projectId={id} defaultPanels={DEFAULT_LAYOUT}>
 *     <FloatingPanel id="chat" title="Chat">...</FloatingPanel>
 *     <FloatingPanel id="canvas" title="Canvas">...</FloatingPanel>
 *   </PanelManagerProvider>
 *
 *   const { panels, setPanelVisible, resetLayout } = usePanelManager();
 *   const { position, size, visible, bringToFront } = usePanelState('chat');
 *
 * 设计选择：
 *   - 自增 z-index（每次 bringToFront 都 +1）—— 简单可靠，不会"溢出"（JS
 *     int 大到不可能用完）；reset layout 时归零
 *   - persist debounce 100ms —— 拖拽中频繁 setState 不要打爆 localStorage
 *   - panel 边界 clamp 在 PanelManager 这层做（不在 FloatingPanel）
 */

const PanelManagerContext = createContext(null);

const Z_BASE = 100;
const PERSIST_DEBOUNCE_MS = 150;

export function PanelManagerProvider({ projectId, defaultPanels, children }) {
  // Init: 从 localStorage 读 + merge defaults。null 时纯 default。
  const [panels, setPanels] = useState(() => {
    const saved = loadLayout(projectId);
    return mergeLayouts(defaultPanels, saved);
  });
  const topZRef = useRef(Z_BASE);

  // 切项目时重新 init
  useEffect(() => {
    const saved = loadLayout(projectId);
    setPanels(mergeLayouts(defaultPanels, saved));
    topZRef.current = Z_BASE;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // 持久化（debounce）
  const saveTimerRef = useRef(null);
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveLayout(projectId, panels);
    }, PERSIST_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [projectId, panels]);

  const setPanelPosition = useCallback((id, position) => {
    setPanels(prev => prev[id]
      ? { ...prev, [id]: { ...prev[id], position } }
      : prev);
  }, []);

  const setPanelSize = useCallback((id, size) => {
    setPanels(prev => prev[id]
      ? { ...prev, [id]: { ...prev[id], size } }
      : prev);
  }, []);

  const setPanelVisible = useCallback((id, visible) => {
    setPanels(prev => prev[id]
      ? { ...prev, [id]: { ...prev[id], visible } }
      : prev);
  }, []);

  const bringToFront = useCallback((id) => {
    topZRef.current = topZRef.current + 1;
    const newZ = topZRef.current;
    setPanels(prev => prev[id]
      ? { ...prev, [id]: { ...prev[id], zIndex: newZ } }
      : prev);
  }, []);

  const togglePanel = useCallback((id) => {
    setPanels(prev => prev[id]
      ? { ...prev, [id]: { ...prev[id], visible: !prev[id].visible } }
      : prev);
  }, []);

  const resetLayout = useCallback(() => {
    clearLayout(projectId);
    topZRef.current = Z_BASE;
    setPanels(defaultPanels);
  }, [projectId, defaultPanels]);

  const value = {
    panels,
    setPanelPosition,
    setPanelSize,
    setPanelVisible,
    bringToFront,
    togglePanel,
    resetLayout,
    defaultPanels,
  };

  return (
    <PanelManagerContext.Provider value={value}>
      {children}
    </PanelManagerContext.Provider>
  );
}

/**
 * 拿全局 panel manager（控制所有 panel）
 */
export function usePanelManager() {
  const ctx = useContext(PanelManagerContext);
  if (!ctx) {
    throw new Error('usePanelManager must be inside <PanelManagerProvider>');
  }
  return ctx;
}

/**
 * 拿单个 panel 的 state + 操作 helper（FloatingPanel 内部用）
 */
export function usePanelState(id) {
  const mgr = useContext(PanelManagerContext);
  if (!mgr) return null;
  const panel = mgr.panels[id];
  return {
    position: panel?.position,
    size: panel?.size,
    visible: panel?.visible !== false,           // undefined 当 true
    zIndex: panel?.zIndex ?? Z_BASE,
    setPosition: (pos) => mgr.setPanelPosition(id, pos),
    setSize: (size) => mgr.setPanelSize(id, size),
    setVisible: (v) => mgr.setPanelVisible(id, v),
    bringToFront: () => mgr.bringToFront(id),
  };
}
