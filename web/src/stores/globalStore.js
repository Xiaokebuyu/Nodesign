import { create } from 'zustand';

/**
 * 全局轻量状态（toast / modal / 跨组件共享的 UI 状态）
 *
 * 项目级状态（messages / spec / html / comments / inputs / runStatus）
 * 不放这里——走每个 /projects/:id 内的 useReducer + Context。
 */
export const useGlobalStore = create((set) => ({
  // ── Toast ──
  toasts: [],
  showToast: (msg, kind = 'info') => set((s) => ({
    toasts: [...s.toasts, { id: Date.now() + Math.random(), msg, kind }],
  })),
  dismissToast: (id) => set((s) => ({
    toasts: s.toasts.filter(t => t.id !== id),
  })),

  // ── Canvas mode（Edit / Preview / Code） ──
  canvasMode: 'edit',
  setCanvasMode: (m) => set({ canvasMode: m }),

  // ── 选中元素锚点（评论 / 直改 / 未来 CAD 共享）──
  selectedAnchor: null,
  setSelectedAnchor: (a) => set({ selectedAnchor: a }),

  // ── Chat draft（让 Inspect "触发新 run" 把元素意图填回 ChatComposer）──
  chatDraft: '',
  setChatDraft: (s) => set({ chatDraft: s }),
  consumeChatDraft: () => {
    const draft = useGlobalStore.getState().chatDraft;
    set({ chatDraft: '' });
    return draft;
  },

  // ── A4：当前活跃 run 上下文 ──
  // AskUserQuestionView 直接 POST /answer 时需要 pid + runId。挂全局
  // 避免 prop drilling 穿过 ChatPanel → MessageList → Message → AskUserQuestionView。
  // ProjectWorkspace 在 run.start 时 setActiveRun({ pid, runId })，
  // run.done/error/cancelled 时 setActiveRun(null)。
  activeRun: null,
  setActiveRun: (activeRun) => set({ activeRun }),

  // ── Phase 3.2：SDK 原生 plan mode 审批 ──
  // run.plan_for_approval 事件 → 设 planForApproval state → ProjectWorkspace
  // 渲染 <PlanReviewCard />。用户 approve/reject 后调 Plan.approve/reject API
  // 然后清空 state。
  planForApproval: null,  // { toolUseId, plan }
  setPlanForApproval: (planForApproval) => set({ planForApproval }),
  clearPlanForApproval: () => set({ planForApproval: null }),

  // ── Phase 3.2：plan-mode toggle ──
  // ChatComposer 旁边的 segmented control "快速做 / 深度对齐"。开 plan-mode
  // 时下次 turn 会走 SDK 原生 plan mode（permissionMode='plan' + ExitPlanMode 流程）。
  // toggle 持久化到 localStorage（用户偏好），单 session 内保持。
  planModeEnabled: (() => {
    try { return localStorage.getItem('nodesign:planMode') === '1'; } catch { return false; }
  })(),
  setPlanModeEnabled: (enabled) => {
    try { localStorage.setItem('nodesign:planMode', enabled ? '1' : '0'); } catch { /* ignore */ }
    set({ planModeEnabled: enabled });
  },

  // ── 模拟登录态（MVP 单用户）──
  user: { id: 'u_self', name: '我', avatar: null },
}));
