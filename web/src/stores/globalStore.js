import { create } from 'zustand';
import { DEFAULT_MODEL_ID } from '../lib/models.js';
import { getLocale, setLocale as applyLocale } from '../lib/i18n.js';

/**
 * 全局轻量状态（toast / modal / 跨组件共享的 UI 状态）
 *
 * 项目级状态（messages / spec / html / comments / inputs / runStatus）
 * 不放这里——走每个 /projects/:id 内的 useReducer + Context。
 */
export const useGlobalStore = create((set) => ({
  // ── 当前登录用户（2026-07-30 多用户内测）──
  // AuthGate 登录/status 后写入；{ id, username, role } | null（登录墙关闭时 null）
  authUser: null,
  setAuthUser: (u) => set({ authUser: u }),
  // 部署形态（/api/auth/status 的 profile）：'hosted' 线上多用户站 | 'local' 本地单租户分发版。
  // local 下账号徽记 / 额度横幅 / 用量面板这些 SaaS 界面整体不渲染（代码不删，只是藏）
  authProfile: 'hosted',
  setAuthProfile: (p) => set({ authProfile: p === 'local' ? 'local' : 'hosted' }),

  // ── 界面语言（2026-08-26 i18n）──
  // 真相源是 lib/i18n.js 的模块级 current（纯数据模块在 React 之外也要 t()）；
  // 这里存一份只为触发重渲染。**唯一写入口是下面的 setLocale**，两处同时更新，
  // 所以不是两个真相源。读语言值一律 getLocale()，别读这个字段。
  locale: getLocale(),
  /** opts.explicit=false 表示这是账号偏好回填，不覆盖本机的显式表态 */
  setLocale: (id, opts) => set({ locale: applyLocale(id, opts) }),

  // ── Toast ──
  toasts: [],
  /** opts.action = { label, onClick }（点了即关）；opts.ttl 毫秒（默认 3500；带 action 默认 8000）*/
  showToast: (msg, kind = 'info', opts = null) => set((s) => ({
    toasts: [...s.toasts, { id: Date.now() + Math.random(), msg, kind, ...(opts?.action ? { action: opts.action } : {}), ...(opts?.ttl ? { ttl: opts.ttl } : {}) }],
  })),
  dismissToast: (id) => set((s) => ({
    toasts: s.toasts.filter(t => t.id !== id),
  })),

  /**
   * 画布手写文字的字体与字号（2026-08-08）。
   *
   * 用户要「不同的、好看的字体供选择」，并且「先放在设置里，默认选一个比较
   * 合适的」。默认楷体：整套语言里正文就是楷体，手写在白板上的一句话跟它同源；
   * 等宽只留给机器写的东西。
   *
   * 存 localStorage 不存后端：它是**这台机器上这个人的手感偏好**，不是项目
   * 属性 —— 同一个项目换台电脑打开，字体该跟着人走而不是跟着项目走。
   */
  canvasFont: (() => {
    try {
      const v = JSON.parse(localStorage.getItem('nd:canvasFont'));
      if (v?.font && v?.size) return v;
    } catch { /* 没设过 / 隐私模式 */ }
    // 默认手写（龙藏体）：白板上随手写的字要像手写的（2026-08-13 用户定）。
    // 已经设过偏好的人不受影响 —— 上面 localStorage 优先。
    return { font: 'pen', size: 'md' };
  })(),
  setCanvasFont: (v) => {
    try { localStorage.setItem('nd:canvasFont', JSON.stringify(v)); } catch { /* */ }
    set({ canvasFont: v });
  },

  /**
   * 镜头跟随 agent（2026-08-08）。开关，默认开。
   *
   * 跟随本身早就有（跟人不跟事件，见 BoardCanvas 的 followTarget），缺的是
   * 一个能关掉它的地方 —— 用户在画布另一头摆自己的东西时，镜头被 agent 拽走
   * 是很烦的。用户接管冷却（8 秒）只能缓解，关不掉。
   */
  followAgent: (() => {
    try {
      const v = localStorage.getItem('nd:followAgent');
      if (v !== null) return v === '1';
    } catch { /* 隐私模式 */ }
    return true;
  })(),
  setFollowAgent: (v) => {
    try { localStorage.setItem('nd:followAgent', v ? '1' : '0'); } catch { /* */ }
    set({ followAgent: v });
  },

  // ── Canvas mode（Edit / Preview / Code） ──
  canvasMode: 'edit',
  setCanvasMode: (m) => set({ canvasMode: m }),

  // ── 选中元素锚点（评论 / 直改 / 未来 CAD 共享）──
  selectedAnchor: null,
  setSelectedAnchor: (a) => set({ selectedAnchor: a }),

  // ── Chat draft（让 Inspect "触发新 run" 把元素意图填回 ChatComposer）──
  chatDraft: '',
  setChatDraft: (s) => set({ chatDraft: s }),
  /**
   * 「把光标放进输入框」的信号（2026-08-08）。
   *
   * 不能靠 chatDraft 兼职：它的消费方判的是 `if (chatDraft)`，而空串是假值 ——
   * 按 `/` 唤出时垫的词恰好就是空串（没有指着任何东西），于是既不填也不聚焦。
   * 用一个只增不减的计数器：值本身没有意义，**变化**才是信号，所以连着按两次
   * 也能各触发一次。
   */
  composerFocusTick: 0,
  focusComposer: () => set((st) => ({ composerFocusTick: st.composerFocusTick + 1 })),
  /**
   * 「唤出悬浮 AI 卡」的信号（2026-08-13，E3）。同上是计数器。
   *
   * 悬浮卡未固定时是收起来的（E2）——就地标注/圈选发送后对话在卡里流，
   * 卡不出来用户就看不见 agent 的回应。focusComposer 也隐含这个语义
   * （对着隐形输入框聚焦是空操作），ChatDock 两个 tick 都听。
   */
  chatDockOpenTick: 0,
  openChatDock: () => set((st) => ({ chatDockOpenTick: st.chatDockOpenTick + 1 })),
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

  // 注：pendingImageApproval state 已删除（2026-05-06）—— 见 ImageApprovalBanner 移除说明。

  // 注：plan mode（「深度对齐」toggle → 后来的 request_plan_mode/PlanReviewCard 审批流）
  // 2026-08-21 整体移除，状态和 API 一起删了。

  // ── 模型选择（2026-07-29）──
  // Composer 里的 picker。选择随**新建会话**那条消息的 body.model 下发，服务端
  // 写进 session-config.json（模型的唯一真相源）；会话建起来之后改模型走
  // PUT /sessions/:sid/model。localStorage 持久化，跨会话沿用。
  //
  // ⚠️ **永远是个具体模型，不会是 null**（2026-08-17）。以前 null 表示"不带
  // model 字段、跟随 NODESIGN_MODEL"，于是 picker 上显示的和实际跑的是两条独立
  // 的链，环境变量一改按钮就开始说谎。现在没选过就是 DEFAULT_MODEL_ID，
  // 显示什么就发什么。清空偏好（传 null）= 回到那个常量，不是回到"不指定"。
  modelPref: (() => {
    try { return localStorage.getItem('nodesign:modelPref') || DEFAULT_MODEL_ID; } catch { return DEFAULT_MODEL_ID; }
  })(),
  setModelPref: (model) => {
    try {
      if (model) localStorage.setItem('nodesign:modelPref', model);
      else localStorage.removeItem('nodesign:modelPref');
    } catch { /* ignore */ }
    set({ modelPref: model || DEFAULT_MODEL_ID });
  },

  // 当前会话跑在**谁家**的模型上（ui/ModelMark.jsx 的 brand）。picker 一问到清单就写这里，
  // 画布精灵读它换身份 —— 精灵和 picker 隔着整棵树，又不该各自去问一遍接口。
  // ⚠️ 只是个显示用的转发，不是模型的真相源：真相在服务端 session-config，
  // 谁要改模型走 PUT /model，别改这个值。
  sessionBrand: null,
  setSessionBrand: (brand) => set((s) => (s.sessionBrand === brand ? s : { sessionBrand: brand })),

  // ── Phase B 批次 3：用户主动 recall project memory 到下一轮 chat ──
  // MemoryCard 点"📎 加到下条消息"会 push 一项到这里；ChatComposer 提交时
  // pendingMemoryRecalls 拼到 chat 字段头部（<memory-recall> 包裹），
  // 跟随 user message 一起发给 SDK。提交成功后 store 清空。
  // shape: [{ agentType, content, ts }]
  pendingMemoryRecalls: [],
  addPendingMemoryRecall: (recall) => set((s) => ({
    pendingMemoryRecalls: [...s.pendingMemoryRecalls, { ...recall, ts: Date.now() }],
  })),
  removePendingMemoryRecall: (idx) => set((s) => ({
    pendingMemoryRecalls: s.pendingMemoryRecalls.filter((_, i) => i !== idx),
  })),
  consumePendingMemoryRecalls: () => {
    const recalls = useGlobalStore.getState().pendingMemoryRecalls;
    set({ pendingMemoryRecalls: [] });
    return recalls;
  },

  // ── Phase B 批次 3：SDK 自动 recall 历史（per-project）──
  // run.memory_recall 事件 → append 到对应 project 的历史。MemoryCard 顶部
  // "最近自动召回"折叠区渲染。重启 server 后清空（in-memory）。
  // shape: { [projectId]: [{ mode, memories, ts }] }
  recallHistoryByProject: {},
  appendRecallHistory: (projectId, entry) => set((s) => {
    if (!projectId) return s;
    const cur = s.recallHistoryByProject[projectId] || [];
    // 上限 50 条避免无限堆积
    const next = [{ ...entry, ts: entry.ts || Date.now() }, ...cur].slice(0, 50);
    return { recallHistoryByProject: { ...s.recallHistoryByProject, [projectId]: next } };
  }),

  // ── 站内 Confirm / Prompt 对话框（替代 window.confirm / window.prompt）──
  // 命令式 Promise API：调用方 `await confirm({ message })` 拿 boolean，
  // `await prompt({ initialValue })` 拿 string|null。
  // 实际 UI 由 <GlobalDialogs /> 在根挂载，监听这两个 state 渲染 ConfirmDialog/PromptDialog。
  // resolve 在用户点确认/取消时被调，随后清掉 state。
  confirmDialog: null,
  promptDialog: null,
  confirm: ({ title = '确认', message = '', confirmLabel = '确认', cancelLabel = '取消', danger = false } = {}) =>
    new Promise((resolve) => {
      // 同时只允许一个 confirm 弹窗——若上一个未关，先 resolve(false) 再起新的
      const prev = useGlobalStore.getState().confirmDialog;
      if (prev?.resolve) prev.resolve(false);
      useGlobalStore.setState({
        confirmDialog: { title, message, confirmLabel, cancelLabel, danger, resolve },
      });
    }),
  prompt: ({ title = '请输入', message = '', initialValue = '', placeholder = '', confirmLabel = '确认', cancelLabel = '取消', validate, multiline = false } = {}) =>
    new Promise((resolve) => {
      const prev = useGlobalStore.getState().promptDialog;
      if (prev?.resolve) prev.resolve(null);
      useGlobalStore.setState({
        promptDialog: { title, message, initialValue, placeholder, confirmLabel, cancelLabel, validate, multiline, resolve },
      });
    }),
  closeConfirmDialog: (result) => set((s) => {
    if (s.confirmDialog?.resolve) s.confirmDialog.resolve(result);
    return { confirmDialog: null };
  }),
  closePromptDialog: (result) => set((s) => {
    if (s.promptDialog?.resolve) s.promptDialog.resolve(result);
    return { promptDialog: null };
  }),

  // ── 模拟登录态（MVP 单用户）──
  user: { id: 'u_self', name: '我', avatar: null },
}));
