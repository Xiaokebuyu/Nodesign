import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { trySayToRole } from '../lib/role-direct.js';
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import { Download, MoreHorizontal } from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
// 主区两栏固定（左 chat + 右 canvas 占满）；5 个次级 UI = 浮窗 bounds=parent
// 限制在 canvas section 内（chat / canvas 不再可拖动 — PLAN.md:431 旧决策回归）。
import FloatingPanel from '../components/layout/FloatingPanel.jsx';
import ChatDock from '../components/layout/ChatDock.jsx';
import { PanelManagerProvider } from '../components/layout/PanelManager.jsx';
// PanelMenu 已下架（用户反馈"面板"按钮太冗余）— 浮窗仍可通过 hooks 直接 toggle
import { Sliders, MessageSquare, MessageSquarePlus } from 'lucide-react';
import ChatPanel from '../components/chat/ChatPanel.jsx';
import CanvasFrame from '../components/canvas/CanvasFrame.jsx';
// InspectTab 由 InspectFloatingCard 间接使用（不在此处直接 import）
// CommentsTab 已删 — comments 嵌入到 InspectFloatingCard
import TweaksPanel from '../components/context-panel/TweaksPanel.jsx';
// DecisionsTab / SystemTab 现在由 SystemPopover 间接使用（CanvasFrame 内）
// 不在此处直接 import — C2 撤销 floating panel 注册
import ShareModal from '../components/project/ShareModal.jsx';
import ExportMenu from '../components/project/ExportMenu.jsx';
import ProjectActionsMenu from '../components/project/ProjectActionsMenu.jsx';
import SnapshotModal from '../components/project/SnapshotModal.jsx';
import UpgradeQuickModal from '../components/project/UpgradeQuickModal.jsx';
import DirectEditModal from '../components/canvas/DirectEditModal.jsx';
import ExportsListModal from '../components/project/ExportsListModal.jsx';
import ExportPicker from '../components/project/ExportPicker.jsx';
import SessionListModal from '../components/project/SessionListModal.jsx';
import ElicitationModal from '../components/run/ElicitationModal.jsx';
import { COLOR, CHROME, GAP, RADIUS, FONT_SIZE, FONT_SANS, FONT_KAI, FONT_MONO, STAGE } from '../lib/theme.js';
import { INK_SURFACE } from '../lib/paper.js';
import { useProjectStore } from '../stores/projectStore.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { newId } from '../lib/helpers.js';
import { findElementByAnchor } from '../lib/html-utils.js';
import { serializeForAI } from '../lib/element-semantics.js';
import { Canvas, Turn, Assets, Exports, Sessions, PendingChanges } from '../lib/api.js';
import { scrollToPage, pulseHighlight } from '../lib/canvas-iframe-ops.js';
import { exportFromMenu } from '../components/canvas/card-export.js';
import { openProjectWS } from '../lib/ws-client.js';
import { sessionMessagesToDisplay } from '../lib/session-to-messages.js';
import { reduceChatEvent, clearThinkingStreaming, mergeLiveTurnSnapshot, mergeHydrated, attachSubagentResult } from '../lib/chat-stream.js';
import { bumpFileVersion, versionOfFile } from '../lib/file-versions.js';

// 事件分流判据（名单+过期规则）2026-08-14 抽进 lib/event-router.js 配单测 ——
// 谁进哪条管线是"精灵丢状态"病族的老巢，判据改动要连测试一起动
import { STAGE_EVENTS, CHAT_STREAM_EVENTS, isStaleEvent } from '../lib/event-router.js';
import { reduceRoleStage, useRoleNames } from '../lib/role-stage.js';
import { usePendingEdits } from '../hooks/usePendingEdits.js';
import { useBrowseWindow } from '../hooks/useBrowseWindow.js';

export default function ProjectWorkspace() {
  // 会话真相源收敛（2026-08-13 E1b）：**服务端指针**（projects.active_session_id）
  // 是唯一真相，URL 不再编码会话。
  //   - /projects/:id/work           唯一入口，跟着项目指针走（刷新即恢复）
  //   - /projects/:id/sessions/:sid  旧链接兼容：采纳该 sid 后归一到 /work
  // 在这之前 URL 是真相源（/work=新会话、/sessions/:sid=续）。收敛动机正是
  // 两个真相源会分叉：显式带旧 sid 的标签页与服务端指针各执一词，两个标签
  // 静默岔成两条会话。指针变化由 project.active_session 事件广播到所有标签。
  const { id, sid: urlSid } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [currentSessionId, setCurrentSessionId] = useState(() => urlSid || null);
  // 旧式 /sessions/:sid 链接进来：采纳一次，URL 归一（会话不再进 URL）
  useEffect(() => {
    if (urlSid) navigate(`/projects/${id}/work`, { replace: true });
    // 只在挂载时归一 —— urlSid 已经进了 state 初值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const adoptedPointerRef = useRef(!!urlSid);

  // Phase A.1（2026-05-07）：sessionId Ref 避开 React 闭包陈旧。
  // handleSend 是 async 闭包，await Turn.send 后再读 currentSessionId 拿的是闭包
  // 创建那一刻的值；navigate 异步触发 useParams 重渲染，但 handleSend 闭包持的还是旧
  // currentSessionId。结果：用户连发两条 chat（极快），第二条 handleSend 读到 null
  // 把 sessionId=null 传给 turn.js → hasActiveQuerySession 返 false → 起新 session。
  // 修法：实时维护 sessionIdRef.current = 当前真值，handleSend 优先读 ref。
  const sessionIdRef = useRef(currentSessionId);
  useEffect(() => {
    sessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  // ── store ──
  const project = useProjectStore(s => s.projects.find(p => p.id === id));
  // 项目档案到位后跟指针（只在本地还没采纳过时 —— 用户点了"新对话"就别拽回去）。
  // ⚠️ 这条 effect 必须待在 `project` 声明之后：依赖数组在**渲染时**求值，
  // 放上面就是 TDZ 白屏（BoardCanvas 栽过四次的同一坑，2026-08-13 这里也栽了一次）。
  useEffect(() => {
    if (adoptedPointerRef.current || !project) return;
    adoptedPointerRef.current = true;
    if (project.activeSessionId) {
      sessionIdRef.current = project.activeSessionId;
      setCurrentSessionId(project.activeSessionId);
    }
  }, [project]);
  const hydrateOne = useProjectStore(s => s.hydrateOne);
  const updateProject = useProjectStore(s => s.updateProject);
  const deleteProject = useProjectStore(s => s.deleteProject);
  const duplicateProject = useProjectStore(s => s.duplicateProject);
  const applyRunEvent = useProjectStore(s => s.applyRunEvent);
  // V2：context 状态从局部 useState 提到 projectStore（per-pid map）—— mount/unmount 不丢，
  // partial event 走 merge 不覆盖已有非空字段。
  const setProjectSystemInfo = useProjectStore(s => s.setProjectSystemInfo);
  const mergeProjectContextUsage = useProjectStore(s => s.mergeProjectContextUsage);
  const setProjectContextUsage = useProjectStore(s => s.setProjectContextUsage);
  const systemInfo = useProjectStore(s => s.contextByProject[id]?.systemInfo || null);
  const contextUsage = useProjectStore(s => s.contextByProject[id]?.contextUsage || null);
  const showToast = useGlobalStore(s => s.showToast);
  const confirm = useGlobalStore(s => s.confirm);
  const prompt = useGlobalStore(s => s.prompt);
  const setChatDraft = useGlobalStore(s => s.setChatDraft);
  // A4.3：维护活跃 run 的 (pid, runId)，让 AskUserQuestionView 能直接 POST /answer
  const setActiveRun = useGlobalStore(s => s.setActiveRun);

  // ── local state ──（所有 useState 必须在 early return 之前；hooks 顺序敏感）
  const [hydrated, setHydrated] = useState(false);
  const [hydrateError, setHydrateError] = useState(null);
  const [messages, setMessages] = useState([]);
  const [inputs, setInputs] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);
  // 台上的常驻角色 slug → { waiting }。⚠️ 跟 isStreaming 是两件事，见 lib/role-stage.js
  const [roleStage, setRoleStage] = useState({});
  const roleNames = useRoleNames(id, roleStage);   // slug → 展示名（GET /roles）
  const [queueDepth, setQueueDepth] = useState(0);  // streamInput 模式下 inputQueue 积压数（"已排队 N 条"）
  const [isTweaksExposed, setIsTweaksExposed] = useState(false);  // agent 调过 expose_tweaks 才在 ChatPanel 显示打开按钮
  const [wsStatus, setWsStatus] = useState('connecting');     // 'connecting' | 'open' | 'reconnecting' | 'closed'
  const [lastEventAt, setLastEventAt] = useState(Date.now()); // 给 ChatPanel header dot 判断"在动 vs 静默"
  const [selectedAnchor, setSelectedAnchor] = useState(null);
  // 浏览器窗（2026-08-18）：会话级临时活物，不是产物 —— 不进 kinds 注册表、
  // 不进 board.json。null = 没开；{url, help} = 开着（help 非空时窗上亮 banner）
  const [browseWin, setBrowseWin] = useBrowseWindow(id);   // 含刷新后拿回状态，见 hook 文件头
  const [iframeDoc, setIframeDoc] = useState(null);
  // 刷新粒度（2026-07-28 重做）：
  //   fileVersions —— 按文件记版本，谁被改了只有谁的 iframe 换 ?v=
  //   listVersion  —— 产物清单版本，去抖合并（agent 一轮几十笔工具调用，
  //                   清单只需要在尘埃落定后重拉一次）
  // 原来是一个全局 reloadToken 两件事一起干：多 deck 任务改一份会让全部 iframe
  // 同时重载（整屏闪），而且每笔动作都重拉一次清单。
  const [fileVersions, setFileVersions] = useState({});
  const [listVersion, setListVersion] = useState(0);
  const listBumpTimerRef = useRef(null);
  const bumpListSoon = useCallback(() => {
    if (listBumpTimerRef.current) clearTimeout(listBumpTimerRef.current);
    listBumpTimerRef.current = setTimeout(() => setListVersion(v => v + 1), 500);
  }, []);
  useEffect(() => () => { if (listBumpTimerRef.current) clearTimeout(listBumpTimerRef.current); }, []);
  // agent 改画布布局（board.updated）→ bump，BoardCanvas 整份重拉 board.json
  const [boardVersion, setBoardVersion] = useState(0);
  // agent 落了草图 → 黑板模式下镜头跟过去（board.focus，2026-08-23）
  const [boardFocus, setBoardFocus] = useState(null);
  // 工作台 UI 态（BoardCanvas 上报）：工具栏 + 会话栏聚焦条共同消费
  const [boardUi, setBoardUi] = useState(null);
  // 画布操作句柄（顶栏面包屑退回项目区 / 刷新产物墙都从这里走）
  const boardApiRef = useRef(null);
  // 舞台层（2026-07-28）：run.* 工具流原样转发进 BoardCanvas，画布演出 agent 实时动作
  const stageRef = useRef(null);
  // 视口容器（画布铺满它、浮窗在它里面拖）。浮动工具栏的限位也用这一个。
  const stageAreaRef = useRef(null);
  useEffect(() => {
    // 换会话大扫除（2026-08-14）：旧会话的舞台卡/在场精灵/手写行全收场 ——
    // 旧 run 的收场事件换会话后会被 stale guard 拦掉，不扫的话精灵冻在
    // "正在干活"里转圈。合成一枚 run.cancelled 走正常收场路（舞台卡清扫 +
    // 在场全体下场都认它）；切进正在跑的会话由 reducer 的"接管显形"补台
    //（主 agent 活动事件到了就地立起来，不等看不见的 run.start）。
    stageRef.current?.onEvent?.({ type: 'run.cancelled', synthetic: true });
  }, [currentSessionId]);

  // 上下文用量：切会话 / 刷新页面时先清掉（上一场的数字不能当这一场用），再向
  // 服务端要这个 session 的当前值。run.context_usage 只在 turn 内推，两轮之间和
  // 刷新之后前端手里是空的 —— 而"要不要先压缩再开新活"恰恰是在这个时候问的。
  useEffect(() => {
    let alive = true;
    setProjectContextUsage(id, null);
    if (!currentSessionId) return () => { alive = false; };
    Sessions.contextUsage(id, currentSessionId)
      .then((u) => { if (alive && u) setProjectContextUsage(id, u); })
      .catch(() => { /* 拿不到就空着，菜单里显示"还没开始对话" */ });
    return () => { alive = false; };
  }, [id, currentSessionId, setProjectContextUsage]);

  /** composer 的 [+] 菜单展开时重新问一次 —— query 活着的话这是 SDK 的现值 */
  const refreshContextUsage = useCallback(() => {
    if (!currentSessionId) return;
    Sessions.contextUsage(id, currentSessionId)
      .then((u) => { if (u) setProjectContextUsage(id, u); })
      .catch(() => { /* fail-soft：菜单继续显示手里已有的数字 */ });
  }, [id, currentSessionId, setProjectContextUsage]);
  // 稳定引用让 ChatPanel/MessageList 下游 React.memo 生效；之前 inline 箭头每次
  // render 都 new function，子组件 props 浅比较永不命中。
  // 回滚（rewindFiles）改动面未知 → 已知文件全量 bump，= 旧全局 reloadToken 的等价物。
  // （reloadToken 在 07-28 按文件版本重构时已拆除，这里曾留着悬空引用，回滚一成功就
  // ReferenceError —— 服务端回滚其实做完了，前端在庆功那一步摔的。08-08 修。）
  const handleCanvasReload = useCallback(() => setFileVersions(
    prev => Object.fromEntries(Object.keys(prev).map(k => [k, (prev[k] || 0) + 1])),
  ), []);

  // ── P0+ s1 C17：SDK 高频事件提升的 state（被 C18/C19/C20 各组件消费）──
  // systemInfo: SDK 'system init' 事件（model / tools / mcp_servers / agents 元信息）
  // promptSuggestion: 每轮后 piggyback 预测的下条 prompt
  // agentProgress: subagent 30s 摘要（"正在分析颜色对比度…"）
  // P0+ s1 C23：toolElapsed 从单独 state 改为写到 message 对象的 elapsed 字段，
  // 消除 prop drilling，Message 组件直接读 message.elapsed。
  // V2：systemInfo / contextUsage 已上提到 projectStore（contextByProject[id]），
  // 走 setProjectSystemInfo / mergeProjectContextUsage 更新；旧的局部 useState 删掉。
  const [promptSuggestion, setPromptSuggestion] = useState(null);
  const [agentProgress, setAgentProgress] = useState(null);
  // 思考心跳（run.status status='thinking' 的累计 tokens）——ChatPanel header
  // "思考中 · ~N tokens" 显示；正文/工具事件到达即清（思考段结束）
  const [thinkingTokens, setThinkingTokens] = useState(null);
  // C5：TweaksPanel 自动刷新触发器（agent 调 expose_tweaks 后 bump）
  const [tweaksReloadKey, setTweaksReloadKey] = useState(0);
  // 终止生成：当前活跃 run 的 id（Turn.send 返回时记，run.done/error/cancelled 清）
  const [currentRunId, setCurrentRunId] = useState(null);
  // Phase A.5：currentRunIdRef 跟 state 同步，给 handleEvent 闭包用（防 stale closure）。
  // run.done/cancelled/error 必须 guard `evt.runId === currentRunIdRef.current` 才清 state，
  // 否则 stale 事件（WS 重放 / 后端慢）会清掉新一 turn 的状态。
  const currentRunIdRef = useRef(null);
  useEffect(() => { currentRunIdRef.current = currentRunId; }, [currentRunId]);
  // （TodoPanel 2026-08-24 退役：TodoWrite 计划清单已上板成看板贴，侧栏那份撤了；
  //   run.todo.updated 事件保留不消费 —— 板贴走服务端落盘那条线，跟这里无关）
  // H1：currentSessionId 来自 URL（urlSid，已在 useParams 上面）
  // title 用 list session 后 match URL sid 拿到
  const [currentSessionTitle, setCurrentSessionTitle] = useState('');
  const [sessionListOpen, setSessionListOpen] = useState(false);

  // Phase B 批次 4：MCP elicitation request 状态。SDK onElicitation 通过
  // run.elicitation_request 事件推 { reqId, request, runId } 进来；
  // ElicitationModal 处理 accept/decline → POST 给 /elicit/:reqId/answer
  const [elicitRequest, setElicitRequest] = useState(null);

  const [shareOpen, setShareOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // 有产物窗铺满屏幕时收掉顶栏的浮现（它的关闭钮在右上角，鼠标够它的路上
  // 必然扫过顶部感应带）
  const [artifactWindowOpen, setArtifactWindowOpen] = useState(false);
  // 聊天卡开着 = 右缘那一整条被它占着，顶栏不浮现（issue #1 第 1、4 条）
  const [chatDockOpen, setChatDockOpen] = useState(false);
  const [exportsListOpen, setExportsListOpen] = useState(false);
  const [pickExportOpen, setPickExportOpen] = useState(false);
  const [pickType, setPickType] = useState(null);   // 从菜单点进来的产物类型
  const [actionsOpen, setActionsOpen] = useState(false);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [directEditOpen, setDirectEditOpen] = useState(false);
  const [directEditAnchor, setDirectEditAnchor] = useState(null);
  const [patches, setPatches] = useState([]);     // P0 mock：D 流盲区，C7 真接
  const [comments, setComments] = useState([]);   // P0 mock：D 流不在范围
  // Pending edits (画布拖移工具) — 后端 PendingChanges 持久化，前端 state 切 session 重拉
  const pendingEditsHook = usePendingEdits({ projectId: id, sessionId: currentSessionId });
  // 最近一条 pending-* edit 的 id —— PostDragNotePanel 的 comment 用它做 linkedToEditId
  const [lastPendingEditId, setLastPendingEditId] = useState(null);
  const exportBtnRef = useRef(null);
  const actionsBtnRef = useRef(null);
  // A2.2b：autoCompact 阈值预警的"已警告"flag。同一轮接近阈值只 toast 一次，
  // 真 compact_boundary 触发时 reset 为 false（下一轮重新累积时可再次预警）。
  const compactWarnedRef = useRef(false);

  // ── memo / callback（必须在 early return 之前）──
  // 设计意图面板一直在渲染一份 mock（"audience: 团队内部"、"首跑 ~30 min" 这种），
  // 对每个项目都显示同一套编出来的内容，看着像是真读了这个项目的 spec。宁可不显示：
  // 假的"设计意图"比空白更误导。真 spec.json 在 workspace 里，接通之前这里给 null。
  const deckSpec = null;

  /**
   * 画布拖移工具：用户拖完一个元素 → DragOverlay 把 payload 推上来
   * payload = { sourceAnchor, move: { container, before }, reactMount, aiContext }
   */
  const handleCommitMove = useCallback(async (payload, revertFn) => {
    if (!payload) return;
    const item = await pendingEditsHook.push({
      kind: payload.duplicate ? 'pending-duplicate' : 'pending-move',
      anchor: payload.sourceAnchor,
      move: payload.move,
      reactMount: payload.reactMount,
      aiContext: payload.aiContext,
    }, revertFn);
    if (item?.id) setLastPendingEditId(item.id);
  }, [pendingEditsHook]);

  /**
   * 画布拖移工具 · 自由模式：用户按 P 切换后拖完一个元素 → 落地为 absolute 定位
   * payload = { sourceAnchor, styleDelta: { position, left, top }, parentAnchor, parentNeedsRelative, reactMount, aiContext }
   * revertFn  = 撤销时把 source 原 inline style 恢复 + 取消父元素 position:relative
   */
  const handleCommitFreePosition = useCallback(async (payload, revertFn) => {
    if (!payload) return;
    const item = await pendingEditsHook.push({
      kind: 'pending-style',
      anchor: payload.sourceAnchor,
      styleDelta: payload.styleDelta,
      reactMount: payload.reactMount,
      ...(payload.constraint ? { constraint: payload.constraint } : {}),
      aiContext: {
        ...payload.aiContext,
        parentAnchor: payload.parentAnchor,
        parentNeedsRelative: payload.parentNeedsRelative,
      },
    }, revertFn);
    if (item?.id) setLastPendingEditId(item.id);
  }, [pendingEditsHook]);

  /**
   * 拖完浮 PostDragNotePanel 收到的 follow-up 评论 → push 一条 comment 关联到 lastEditId
   * agent 看到 comment with linkedToEditId 时一起处理（comment 是对那次 edit 的补充指令）
   */
  const handleSubmitDragNote = useCallback(async (sourceAnchor, text) => {
    if (!text || !text.trim()) return;
    if (!lastPendingEditId) return;
    await pendingEditsHook.push({
      kind: 'comment',
      anchor: sourceAnchor,
      text: text.trim(),
      linkedToEditId: lastPendingEditId,
    });
  }, [pendingEditsHook, lastPendingEditId]);

  // handleApplyPendingEdits 引用 handleSend（声明在更下方）—— useCallback 只 store
  // 函数体，user 点 Apply 时才查 handleSend，那时已声明，closure 安全。
  // 用 ref 持 handleSend 避免每次它 re-create 时本 callback deps 跟着 break。
  const handleSendRef = useRef(null);
  const handleApplyPendingEdits = useCallback(() => {
    const count = pendingEditsHook.edits.length;
    if (count === 0) return;
    const summary = describeEditsForChat(pendingEditsHook.edits);
    // 不点名文件：站点任务没有 canvas.html，写死会让 agent 去找一个不存在的文件。
    // pending change 自己带着 path，让 agent 从那里读。
    const message = `应用我刚在画布上做的 ${count} 处调整（${summary}）。请用 get_pending_changes 拉详情，按每条自带的路径和 anchor 改对应文件，处理完调 clear_pending_changes。`;
    handleSendRef.current?.(message);
  }, [pendingEditsHook.edits]);

  // 浮窗默认 layout —— chat / canvas 改回固定栏（不浮）；
  // 5 个次级 UI 仍是浮窗（bounds = canvas 容器），默认 hidden 按需 spawn。
  // position 是相对 canvas 容器的坐标系（不是 viewport）。
  // y 起点 64 = 避开 canvas toolbar（~44px）+ 留 20px 呼吸。
  // C2/C3：浮窗体系收口
  //  - system / decisions → toolbar Settings popover（C2）
  //  - inspect / comments → 选中元素自动弹的 contextual InspectFloatingCard（C3）
  //  - 仅 tweaks 保留 floating panel（C5 schema 驱动）
  const defaultPanels = useMemo(() => {
    // 聊天栏默认贴右侧、留出顶栏高度，高度吃满可视区。**位置只是默认值** ——
    // 拖过一次之后就由 localStorage 说了算（PanelManager 持久化 per-project）。
    // 用 window 尺寸算是因为 panel 坐标是绝对像素，而"贴右边"要知道容器多宽；
    // 容器就是视口减顶栏，首帧拿 window 足够准，之后 ResizeObserver 会收边。
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1440;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 900;
    const chatW = 380;
    // chat 不在这张表里了：它 2026-08-08 起是钉在右缘的 ChatDock，自己管
    // 收起/宽度，**位置不再是一个状态**。留在这里只会让 PanelManager 继续
    // 持久化一份没人读的坐标。
    return {
      tweaks: { position: { x: 96, y: 160 }, size: { width: 320, height: 360 }, visible: false, zIndex: 100 },
    };
  }, []);

  const panelMeta = useMemo(() => ({
    tweaks:    { label: 'Tweaks',    icon: Sliders },
  }), []);

  const handleIframeReady = useCallback((iframe) => {
    try { setIframeDoc(iframe.contentDocument); } catch { /* cross-origin */ }
  }, []);

  // ── mount: hydrate project ──
  useEffect(() => {
    let cancelled = false;
    setHydrated(false);
    setHydrateError(null);
    hydrateOne(id)
      .then(() => { if (!cancelled) setHydrated(true); })
      .catch((err) => { if (!cancelled) { setHydrated(true); setHydrateError(err); } });
    return () => { cancelled = true; };
  }, [id, hydrateOne]);

  // H1：拉 session 元信息更新 title（依赖 url sid + project ready + titleRefreshKey）
  // titleRefreshKey 每次 run.done 时 bump，让 SDK 自动总结的最新 summary 能反映到 UI
  // （SDK 用 haiku helper 在每个 turn 后 incrementally 更新 summary，落 JSONL）
  const refreshSessionTitle = useCallback(async () => {
    if (!currentSessionId) return;
    try {
      const { sessions = [] } = await Sessions.list(id, { limit: 100 });
      const match = sessions.find(s => s.sessionId === currentSessionId);
      if (match) setCurrentSessionTitle(match.customTitle || match.summary || '');
    } catch (err) {
      console.warn('[Project] list sessions failed:', err.message);
    }
  }, [id, currentSessionId]);

  useEffect(() => {
    if (!hydrated || hydrateError || !project) return;
    if (!currentSessionId) {
      setCurrentSessionTitle('');
      return;
    }
    refreshSessionTitle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, hydrated, hydrateError, project?.id, currentSessionId]);

  // H1：hydrate session messages（依赖 url sid）
  // 防 wipe optimistic：streamInput 模式下 user msg 是 push 进 inputQueue（内存）
  // 不立即写 JSONL，handleSend 后 navigate `/work` → `/sessions/<sid>` 触发本
  // useEffect 时 Sessions.read 拿到的 JSONL 还没含刚发的 user msg → display 空 →
  // 直接 setMessages(display) 会把 handleSend 乐观插入的 user msg 覆盖丢失。
  // 现象：用户发首条消息后前端不显示，但后端已在跑 → assistant delta 突然推上来。
  // 修法 ①：新建 session 路径（prevHydrateSidRef=null + prev 已含乐观 msg）跳过
  //   hydrate，信任前端 state + WS run.delta.* 流式更新。
  // 修法 ②：display 缺的乐观 user msg（按 content 匹配）保留——server 慢一拍 flush 时不丢。
  // 修法 ③（2026-07-28）：这条 HTTP 通道只是 WS hydrate 的兜底。WS 那条已经把
  // 「历史 + 进行中 turn 快照」按边界拼好了，这条慢一拍回来会整体替换 messages，
  // 把进行中 turn 的正文洗掉（"漏传"）。WS hydrate 已落地同一个 sid → 直接放弃。
  const prevHydrateSidRef = useRef(null);
  const wsHydratedSidRef = useRef(null);

  // 回滚成功后对话层重拉（2026-08-08）：服务端已把 jsonl 截断，这里强制整体替换
  // messages（回滚时必无进行中 turn，不存在洗掉流式正文的问题）。
  useEffect(() => {
    const onRewound = (e) => {
      if (!currentSessionId || e.detail?.sessionId !== currentSessionId) return;
      Sessions.read(id, currentSessionId)
        .then(({ messages: m = [] }) => setMessages(sessionMessagesToDisplay(m)))
        .catch(() => { /* 拉不到就等下次切会话自然重拉 */ });
    };
    window.addEventListener('nd-conversation-rewound', onRewound);
    return () => window.removeEventListener('nd-conversation-rewound', onRewound);
  }, [id, currentSessionId]);

  // 板书控件（08-25 nd:controls 围栏）：MdInk 里的按钮点了发这个事件 —— 非触发件
  // 攒进 pending（同标注「攒着」一条路），触发件直接起轮（攒的那批靠每轮注入的
  // pending 提示一起被拉走）。handleAnnotate 定义在 early-return 之后，走 ref。
  const handleAnnotateRef = useRef(null);
  const controlQueueRef = useRef(new Map());   // `${chalkId}|${label}|${prompt}` → 待发项 cid（二击取消要撤回）
  useEffect(() => {
    const onControl = (e) => {
      const d = e.detail || {};
      if (!d.chalkId) return;
      const key = `${d.chalkId}|${d.label}|${d.prompt || ''}`;
      if (d.cancel) {
        // 取消勾选 = 从待发队列真撤回，不是再排一条（08-25 用户报）
        const cid = controlQueueRef.current.get(key);
        if (!cid) return;
        controlQueueRef.current.delete(key);
        setComments(arr => arr.filter(c => c.id !== cid));
        PendingChanges.clear(id, [cid]).catch(() => {});
        return;
      }
      const text = d.prompt || d.label || '';
      if (d.trigger) {
        const target = {
          id: d.chalkId, path: d.path || d.chalkId, title: d.title || '板书',
          typeLabel: '板书', chalk: true, by: 'agent',
        };
        handleAnnotateRef.current?.({ target, text: text || '按板上勾选的继续', queue: false });
        return;
      }
      if (!text) return;
      // 排队走标注「攒着」同一条路，但 cid 记在本层 —— 取消要认领得到
      const cid = newId('cmt');
      const item = {
        id: cid, kind: 'comment',
        anchor: { board: d.chalkId, label: `板书「${d.title || '选项'}」` },
        path: d.path || d.chalkId, text,
      };
      controlQueueRef.current.set(key, cid);
      setComments(arr => [...arr, { ...item, board: d.chalkId, status: 'open', createdAt: new Date().toISOString() }]);
      PendingChanges.push(id, item).catch((err) => console.warn('[controls] queue failed:', err.message));
    };
    window.addEventListener('nd:board-control', onControl);
    return () => window.removeEventListener('nd:board-control', onControl);
  }, [id]);
  useEffect(() => {
    if (!currentSessionId) {
      // /work 路径 = 新会话 → 空 chat 让用户从头开始
      setMessages([]);
      prevHydrateSidRef.current = null;
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { messages: sessionMsgs = [] } = await Sessions.read(id, currentSessionId);
        if (cancelled) return;
        const display = sessionMessagesToDisplay(sessionMsgs);
        setMessages(prev => {
          if (wsHydratedSidRef.current === currentSessionId) {
            if (import.meta.env.DEV) console.info('[H1] WS hydrate 已接管，跳过 HTTP 兜底');
            return prev;
          }
          // 修法 ①：新建 session navigate 路径（null → 真 sid，prev 已乐观插入）
          // → streamInput user msg 在 inputQueue 不在 JSONL，hydrate 拿到空数组
          // 会把乐观插入吞掉。直接信任 prev 不替换。
          const isNewSessionNavigation = prevHydrateSidRef.current === null && prev.length > 0;
          if (isNewSessionNavigation) {
            if (import.meta.env.DEV) console.info('[H1] skip hydrate on new-session navigation, trust optimistic + WS delta');
            return prev;
          }
          // 修法 ②：display 缺的乐观 user msg（content 不匹配）保留——双保险
          const displayUserContents = new Set(
            display.filter(m => m.role === 'user').map(m => (m.content || '').trim())
          );
          const orphans = prev.filter(m =>
            m.role === 'user' && !displayUserContents.has((m.content || '').trim())
          );
          if (orphans.length > 0) {
            if (import.meta.env.DEV) console.warn(`[H1] kept ${orphans.length} orphan optimistic user msg(s) — JSONL flush race`);
            return [...display, ...orphans];
          }
          return display;
        });
        prevHydrateSidRef.current = currentSessionId;
      } catch (err) {
        console.warn('[Project] hydrate session messages failed:', err.message);
        setMessages([]);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, currentSessionId]);

  // session/project 切换时重置 per-session UI state，防止跨 session/project 串话：
  // - comments：纯前端 state（D 流接通前没持久化），切 session 旧 session 评论
  //   仍残留在数组里，用户在新 session 看到错的评论
  // - patches：同上
  // - selectedAnchor：上个 session 选中的元素 anchor 切到新 session 不再有意义
  // - 浮窗（inspect / a11y popover）切 session 时该关掉
  useEffect(() => {
    setComments([]);
    setPatches([]);
    setSelectedAnchor(null);
    setInputs([]);                    // 清空附件托盘
    setPromptSuggestion(null);        // 清掉上 session 残留 SuggestionChip
    setAgentProgress(null);           // 清 subagent progress
    setThinkingTokens(null);          // 清思考心跳
    setQueueDepth(0);                 // 清 queue depth（切 session 跨 query 不延续）
    setLastEventAt(Date.now());       // 重置事件时间避免切 session 时 header dot 误判"静默"
    setIsTweaksExposed(false);        // 切 session 时清，新 session 待 agent 重 expose
    // run 状态也要清（丢状态路径 P13）：旧 session 的 runId 留在 currentRunIdRef
    // 会让新 session 的事件全被 stale guard 吞掉。清完由重连后 server 的
    // ws.connected(activeRunId) + ws.live_turn 快照权威恢复（本 session 真在跑时
    // 会立刻拉回 streaming 态，最多闪一下）。
    setIsStreaming(false);
    currentRunIdRef.current = null;
    setCurrentRunId(null);
    setActiveRun(null);
    wsHydratedSidRef.current = null;   // 换 session = 重新等这条 sid 的 WS hydrate
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, currentSessionId]);

  // ── open WS once project exists ──
  // 依赖 project?.id 而非整个 project 对象，避免 status patch 触发重连
  // Phase A.4：wsRef 让 currentSessionId 变化时能调 reconnectForSession 让 server 用新 sid 推 hydrate
  const wsRef = useRef(null);
  // Phase A.4：hydrate 缓冲 — chunks 累积到 end 一次性 setMessages
  const hydrateBufferRef = useRef([]);
  // agent 已推过的下载 url（WS 重放/多 tab 时不重复触发浏览器下载）
  const deliveredRef = useRef(new Set());
  useEffect(() => {
    if (!hydrated || hydrateError || !project) return;
    const ws = openProjectWS({
      projectId: id,
      // Phase A.4：getSid callback 让 ws-client 重连时能拿到最新 sid（避免闭包陈旧）
      getSid: () => sessionIdRef.current,
      onEvent: (evt) => {
        setLastEventAt(Date.now());     // 记录最近一次事件时间，给"无事件超时"用
        applyRunEvent(id, evt);
        handleEvent(evt);
      },
      onStatusChange: (status) => {
        setWsStatus(status);
        // 'closed'：连接彻底放弃 → 安全 fallback isStreaming=false（UI 不再显示
        // stop 按钮，run 状态不可知）。'reconnecting' **不动** isStreaming：
        // 重连成功后 server 在 ws.connected 帧里报 activeRunId 权威同步状态
        // （见下面 case 'ws.connected'）。原版 reconnecting→false 是 over-correct
        // —— run.start 是过去事件，重连若没新事件就永远拉不回 streaming UI，
        // 后端消息源源不断但前端 stop 按钮没了，用户感知=流断了。
        if (status === 'closed') {
          setIsStreaming(false);
        }
      },
    });
    wsRef.current = ws;
    // 记录本条 WS 是用哪个 sid 打开的 —— sid 变化判定的基准。
    // 老逻辑用 null 当"首挂载"哨兵，导致 /work（sid=null）起新 session 后
    // 跳过重连，WS 一直挂在 sid=null 上收不到 hydrate/快照（丢状态路径 P10）。
    lastReconnectedSidRef.current = sessionIdRef.current ?? null;
    return () => {
      wsRef.current = null;
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, hydrated, hydrateError, project?.id]);

  // currentSessionId 变化（含 /work → 新建 session）时重连 WS，
  // 让 server 按新 sid 走 hydrate + live_turn 快照协议
  const lastReconnectedSidRef = useRef(null);
  useEffect(() => {
    if (!wsRef.current) return;
    if (lastReconnectedSidRef.current === currentSessionId) return;
    lastReconnectedSidRef.current = currentSessionId;
    wsRef.current.reconnectForSession?.();
  }, [currentSessionId]);

  // ── H4a: auto-send initialMessage from location.state（HubInput 入口）──
  // Hub 用户在 input box 输入 → navigate('/work', { state: { initialMessage } })
  // 这里 mount 完毕 + project hydrated + WS 上线后自动发送一次，无感跳转。
  // 用 ref 防双发（StrictMode + state 闭包都可能触发重入）；发完 navigate
  // replace 清 state 防刷新重发。
  const initialMessageSentRef = useRef(false);
  useEffect(() => {
    if (!hydrated || hydrateError || !project) return;
    if (initialMessageSentRef.current) return;
    // QuickEntry / HubInput 入口在 navigate state 里捎带 attachments（已上传到
    // shared/assets/，格式 [{ type:'asset', path, name, size, mime }]）—— 首条 turn
    // 一起喂给 agent，turn.js composeUserMessage 会自动加"已附上 N 张参考图 / 可用素材路径"
    // 的系统提示，agent 这一轮就能看到/读到。
    const stateAttachments = Array.isArray(location.state?.attachments)
      ? location.state.attachments
      : [];
    const initial = typeof location.state?.initialMessage === 'string'
      ? location.state.initialMessage.trim() : '';
    // 首页那条路同样允许「只传附件就开工」（issue #1 第 8 条），所以判空要连
    // 附件一起判：两样都没有才是真的没东西可发。
    if (!initial && stateAttachments.length === 0) return;
    initialMessageSentRef.current = true;

    const text = initial;
    // 等 WS 连上一两个 tick 再发，确保 run.start 等事件能收到
    const t = setTimeout(async () => {
      const bubble = text || `（附件：${stateAttachments.map(a => a.name || a.path).join('、')}）`;
      setMessages((ms) => [...ms, { id: newId('msg'), role: 'user', content: bubble }]);
      // 跟 handleSend 同步：sidForRequest 优先用 ref（避 React 闭包陈旧）
      const sidForRequest = sessionIdRef.current ?? currentSessionId;
      try {
        const { runId, sessionId: returnedSid } = await Turn.send({
          pid: id,
          chat: text,
          attachments: stateAttachments,
          sessionId: sidForRequest,  // /work 路径 → null（新会话）；/sessions/:sid → 续约
          // 只有**新建会话**才带模型偏好：会话建起来之后模型的真相在服务端的
          // session-config，picker 直接改那边。每条消息都捎上本地偏好的话，在另一台
          // 机器上为这个会话选的模型会被本机的旧偏好悄悄改回去。
          model: sidForRequest ? undefined : (useGlobalStore.getState().modelPref || undefined),
        });
        setCurrentRunId(runId);
        setActiveRun({ pid: id, runId });  // A4.3：让 AskUserQuestionView 直 POST /answer
        // Phase A.1 对齐 handleSend：起新 session 时**立即**同步 ref + state。
        // 否则用户在首条 turn 期间追加消息，sessionIdRef.current 仍是 null，
        // handleSend 会带 sessionId=null 再起一条新 session 脱钩。
        // （URL 不再动 —— 服务端已在 turn 里把指针写到这条会话）
        if (!sidForRequest && returnedSid) {
          sessionIdRef.current = returnedSid;
          setCurrentSessionId(returnedSid);
        }
        // 清 location.state 防 navigate 后退/刷新重发
        navigate(location.pathname, { replace: true, state: null });
      } catch (err) {
        setMessages((ms) => [...ms, {
          id: newId('msg'), role: 'assistant',
          content: `_⚠️ 发送失败：${err.message}_`,
        }]);
        showToast(`发送失败：${err.message}`, 'error');
        // 失败也清 location.state 防 navigate 后退/刷新重发
        navigate(location.pathname, { replace: true, state: null });
      }
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, hydrateError, project?.id, location.state]);

  /** WS 事件 → chat messages / iframe reload 翻译层 */
  function handleEvent(evt) {
    // Stale event guard — WS replay / 跨 session 旁路事件 / 多 tab 同 sid 收到非
    // 当前 turn 的 delta 时直接 ignore。projectBuses per-project 共享，server 端虽然
    // 在 ws/index.js 已按 sid 过滤但仍可能漏（旧事件没 enrich sessionId / 多 tab 同 sid
    // 时 currentRunIdRef 跨 tab 不同步）。这里再做一道 guard。
    //
    // ws.* / run.done / run.error / run.cancelled / run.query.* 等"控制帧"或本身已带
    // stale guard 的事件不走这个 helper。
    const liveRunId = currentRunIdRef.current;
    const liveSid = sessionIdRef.current;
    // 判据在 lib/event-router.js（配单测）："有值且不匹配才算过期"
    const isStale = isStaleEvent(evt, { runId: liveRunId, sessionId: liveSid });

    // ── 1. 舞台旁路 ──：工具流 / 文件变更 / 收场信号原样转发给工作台画布
    // （agent 实时动作演出）。BoardCanvas 未挂载时 stageRef.current 为 null，自然丢弃。
    setRoleStage(prev => reduceRoleStage(prev, evt));   // 台上名单，见 lib/role-stage.js

    if (STAGE_EVENTS.has(evt.type) && !isStale) {
      stageRef.current?.onEvent?.(evt);
    }

    // ── 2. 聊天流折叠（lib/chat-stream.js 纯 reducer，语义有单测固化）──
    // 这五类事件除了折 messages 只有一个副作用：正文开始流 = 思考段结束。
    if (CHAT_STREAM_EVENTS.has(evt.type)) {
      if (isStale) return;
      if (evt.type === 'run.delta.text') setThinkingTokens(null);
      setMessages(prev => reduceChatEvent(prev, evt));
      return;
    }

    // ── 3. 其余：协议帧 / run 生命周期 / UI 副作用 ──
    switch (evt.type) {
      // ── Phase A.4：WS hydrate 协议（server 推完整 messages 让前端不依赖 HTTP Sessions.read）──
      case 'ws.hydrate.start':
        // start { total, asOfSeq } 或 { kind:'error' }
        if (evt.kind === 'error') {
          // hydrate 失败兜底：原 useEffect[currentSessionId] Sessions.read 仍跑，作为 HTTP fallback
          if (import.meta.env.DEV) console.warn('[ws.hydrate] server-side error:', evt.error);
          break;
        }
        hydrateBufferRef.current = [];
        break;
      case 'ws.hydrate.chunk':
        if (Array.isArray(evt.messages)) {
          hydrateBufferRef.current = [...hydrateBufferRef.current, ...evt.messages];
        }
        break;
      case 'ws.hydrate.end': {
        const buffer = hydrateBufferRef.current;
        hydrateBufferRef.current = [];
        wsHydratedSidRef.current = evt.sessionId || sessionIdRef.current || null;
        const display = sessionMessagesToDisplay(buffer);
        // 防 wipe optimistic：hydrate 拿到空 messages（jsonl 还没 flush）但 current 有
        // 内容（用户刚 setMessages 的 user msg + 流式 delta）→ 信任 current 不替换
        // 防 wipe 乐观消息 / orphan 保留 —— 语义在 lib/chat-stream.js（有单测）
        setMessages(prev => mergeHydrated(prev, display));
        break;
      }
      case 'project.active_session': {
        // 会话指针变了（别的标签页切换/新建/删除，或 turn 写回）。指针是真相源，
        // 空闲的标签页跟着走；正在流式的标签页不动 —— 把用户正看着的对话
        // 从脚下抽走比短暂不同步糟得多，它结束后下一次指针变化会再对齐。
        const next = evt.activeSessionId || null;
        if (next !== sessionIdRef.current && !currentRunIdRef.current) {
          sessionIdRef.current = next;
          setCurrentSessionId(next);
        }
        break;
      }

      case 'ws.connected': {
        // ws-client 处理 lastSeq；此处按 server 报的 activeRunId 恢复/同步 streaming 状态
        // —— 抖动期间 onStatusChange 不再强制 reset isStreaming，重连后由这里权威决定。
        //
        // 三种情况：
        //   ① server 有 activeRunId 且匹配前端持有的 currentRunIdRef → 同一 run 还活着，
        //      恢复 isStreaming=true（重连前可能因 closed 短暂被 set false）
        //   ② server 没 activeRunId 但前端以为还在跑 → run 在断线期间结束（run.done/error
        //      早就发完且 buffer 已挤掉）→ cleanup state
        //   ③ server activeRunId 跟前端不一致 → 多 tab race / 前端 stale；按 server 真相调整
        const serverRunId = evt.activeRunId || null;
        const localRunId = currentRunIdRef.current;
        if (serverRunId) {
          setIsStreaming(true);
          if (serverRunId !== localRunId) {
            currentRunIdRef.current = serverRunId;
            setCurrentRunId(serverRunId);
            setActiveRun({ pid: id, runId: serverRunId });
          }
          // 精灵接管（2026-08-14 首条消息真空修）：真的 run.start 多半已丢 ——
          // 新项目首条消息时 WS 还挂在 sid=null 上，服务端把 session-scoped
          // 事件全滤掉了，等 POST 返回带新 sid 重连，run.start 早发完了；断线
          // 重连同理。聊天靠 live_turn 快照补课，在场表没有快照 —— server 报
          // activeRunId 就是"在跑"的权威话，合成一枚 run.start 让主 agent 立即
          // 上场（reducer 对已在场的 run.start 幂等，网络抖动多来几次无害）。
          stageRef.current?.onEvent?.({ type: 'run.start', synthetic: true, runId: serverRunId });
        } else if (localRunId) {
          setIsStreaming(false);
          currentRunIdRef.current = null;
          setCurrentRunId(null);
          setActiveRun(null);
          setMessages(prev => clearThinkingStreaming(prev));
          // 对称收场：断线期间 run 已结束（run.done 错过且 buffer 挤掉了）——
          // 不扫的话精灵冻在"正在干活"里转圈，同六批换会话那枚合成事件。
          stageRef.current?.onEvent?.({ type: 'run.cancelled', synthetic: true });
        }
        break;
      }

      case 'ws.live_turn': {
        // 进行中 turn 的物化快照（server live-turn.js 折叠）—— 排在 hydrate 之后到达。
        // 覆盖"刷新 / 断线期间错过的全部流式内容"：文本、thinking、工具卡（含
        // AskUserQuestion 的 toolInput，问题卡直接复原可答）。
        if (evt.sessionId && liveSid && evt.sessionId !== liveSid) break;
        // 快照对本 turn 权威 —— 合并语义在 lib/chat-stream.js（有单测）
        setMessages(prev => mergeLiveTurnSnapshot(prev, evt.messages, evt.runId));
        // running=false = 刚收尾那轮的尾巴（server 留了几秒 grace 防收尾瞬间重连
        // 内容重复）。只认消息，不要把界面切回"正在跑"。
        if (evt.runId && evt.running !== false) {
          setIsStreaming(true);
          currentRunIdRef.current = evt.runId;   // 同步落 ref：紧跟其后的 delta 不被 stale guard 吞
          setCurrentRunId(evt.runId);
          setActiveRun({ pid: id, runId: evt.runId });
        }
        if (evt.contextUsage) mergeProjectContextUsage(id, evt.contextUsage);
        break;
      }

      case 'run.start':
        if (isStale) break;
        setIsStreaming(true);
        setThinkingTokens(null);
        // API / 多 tab 触发的 turn 也要能答题（AskUserQuestion 卡 POST /answer 要
        // activeRun）：run.start 即认领。handleSend 已设过时同值幂等；跨会话/旧 run
        // 已被 isStale 滤掉。
        if (evt.runId) {
          // ref 同步落地：setCurrentRunId 的 useEffect 要等 React 提交后才写 ref，
          // 而 delta 可能在同一拍就到 —— 那时 ref 还是上一轮的 runId，isStale 会把
          // 新一轮开头的正文整段吞掉（"漏传"）。
          currentRunIdRef.current = evt.runId;
          setCurrentRunId(evt.runId);
          setActiveRun({ pid: id, runId: evt.runId });
        }
        break;
      case 'run.permission_mode_changed':
        // 前端不镜像 mode（plan mode 08-21 整体移除后只剩 turn 入口的 mode 校正会发它）。事件保留不处理。
        break;
      case 'run.queue.depth':
        if (isStale) break;
        // streamInput 模式：inputQueue 积压数变化（push 后 / 处理完一条后）
        setQueueDepth(typeof evt.depth === 'number' ? evt.depth : 0);
        break;
      case 'run.query.end':
        if (isStale) break;
        // 整个 session 的 query 死了 —— 清 queue depth + 提示用户
        setQueueDepth(0);
        break;
      case 'run.todo.updated':
        // TodoPanel 08-24 退役：计划看板走画布上的看板贴，这个事件前端不再消费
        break;
      case 'run.done': {
        dropPendingCompactCard();
        // Phase A.5：用 ref 拿最新 currentRunId（handleEvent 闭包持的 currentRunId
        // 可能 stale）。stale run.done（WS 重放 / 后端慢推上一 turn 的 result）来时
        // 如果当前已是新 turn，不能清 state（会让用户的新 turn 假死）。
        const liveRunId = currentRunIdRef.current;
        if (liveRunId && evt.runId && evt.runId !== liveRunId) {
          // stale event，仅 clearThinking 兜底但不动 isStreaming / currentRunId
          if (import.meta.env.DEV) console.warn(`[event] stale run.done ${evt.runId} (current ${liveRunId}), ignoring state cleanup`);
          setMessages(prev => clearThinkingStreaming(prev));
          break;
        }
        setIsStreaming(false);
        setCurrentRunId(null);
        setActiveRun(null);
        setThinkingTokens(null);
        // 收尾：清 thinking 流式光标（run 结束后最后一条 thinking 不该一直闪）
        setMessages(prev => clearThinkingStreaming(prev));
        // 双保险：万一 PostToolUse 那一发没到（SDK 边角问题），收尾时补拉一次
        // **清单**。不再无条件 bump 所有 iframe —— 没有文件变过就不该重载，
        // 那正是"每次动作完都刷一次"的来源。
        bumpListSoon();
        // 配额横幅（QuotaBanner）监听这个事件补拉用量 —— 撞限额大多发生在一轮
        // 大活刚跑完，等 60s 轮询会晚一拍
        window.dispatchEvent(new Event('nd-usage-refresh'));
        // Phase B 批次 5：SDK 用 haiku helper incrementally 更新 session summary
        // 落 JSONL，run.done 后 refetch 让 chat 头部 / 面包屑 title 反映最新总结。
        // 已有 sid 的场景立即刷；新建场景 handleSend 已即时 navigate 到 /sessions/<sid>。
        if (currentSessionId) {
          refreshSessionTitle();
        }
        // 注意：之前这里有"!currentSessionId 时 Sessions.list({limit:1}) → navigate
        // 到最近 session"的兜底，意图是新会话首跑完后同步 URL。但 handleSend /
        // handleSendInitialMessage 拿到 returnedSid 已即时 navigate，这里冗余；
        // 而当用户在旧 session 还在跑时主动切到 /work（"+ 新会话"），这段会用
        // Sessions.list 拿到的"最近 session"把用户弹回老 sid → 用户感知"新 session
        // 跳回旧会话 + 上下文串味"。删除让用户的 /work 选择生效。
        break;
      }
      case 'run.file_changed':
        // 2026-07-28 起事件源=PostToolUse 直发（agent 每写完一笔就来一发）。
        // 只给**被改的那个文件**记一笔版本：改哪份 deck 就只有那份 iframe 换 ?v=，
        // 同任务里的其他 deck 纹丝不动（多 deck 任务整屏闪的根因）。
        // 站点的 .css / .js 也算 —— 它们不自己渲染，但整站版本会跟着涨。
        // .md 也算：任务便利贴（tasks/*/notes/*.md）要当场上墙
        // .docx 也算：build_docx 完会发一笔（卡片的页图 ?v= 按它换，不发的话
        // 卡片停在旧页图等 60 秒缓存过期）
        if (typeof evt.filePath === 'string'
            && (/\.(html?|css|js|md|docx)$/i.test(evt.filePath) || /(^|\/)assets\//.test(evt.filePath))) {
          setFileVersions(prev => bumpFileVersion(prev, evt.filePath));
          bumpListSoon();   // 新文件要进产物墙，但去抖合并，不是每笔都拉
        }
        break;
      case 'run.error': {
        dropPendingCompactCard();
        // Phase A.5：stale event guard，同 run.done
        const liveRunId = currentRunIdRef.current;
        if (liveRunId && evt.runId && evt.runId !== liveRunId) {
          if (import.meta.env.DEV) console.warn(`[event] stale run.error ${evt.runId} (current ${liveRunId}), ignoring`);
          break;
        }
        setIsStreaming(false);
        setCurrentRunId(null);
        setActiveRun(null);
        setThinkingTokens(null);
        setMessages(prev => [...clearThinkingStreaming(prev), {
          id: newId('msg'),
          role: 'assistant',
          content: `_⚠️ ${evt.message || '运行出错'}_`,
        }]);
        showToast(`运行失败：${evt.message || '未知错误'}`, 'error');
        break;
      }
      case 'run.cancelled': {
        dropPendingCompactCard();
        // Phase A.5：stale event guard，同 run.done
        const liveRunId = currentRunIdRef.current;
        if (liveRunId && evt.runId && evt.runId !== liveRunId) {
          if (import.meta.env.DEV) console.warn(`[event] stale run.cancelled ${evt.runId} (current ${liveRunId}), ignoring`);
          break;
        }
        setIsStreaming(false);
        setCurrentRunId(null);
        setActiveRun(null);
        setPromptSuggestion(null);
        setAgentProgress(null);
        setMessages(prev => clearThinkingStreaming(prev));
        showToast('已取消', 'info');
        // streamInput 模式：cancel 只是 interrupt 当前 turn，query 仍活着接下条 message。
        // 跟 run.done 同款删除：见 run.done case 注释——Sessions.list({limit:1})
        // 兜底会把主动切到 /work 的用户弹回最近 session（老会话还在跑时尤甚）。
        break;
      }

      // ── SDK helper events（P0：Phase B 批次 1）──

      case 'run.rate_limit': {
        if (isStale) break;
        // 速率限制状态变化（rate_limit_event）。SDK 只在状态变化时推，不会刷屏。
        // - rejected：真触发限制 → error toast
        // - allowed_warning：接近限制 → warn toast 带使用率
        // - allowed：恢复正常 → 不 toast（避免噪声）
        const info = evt.info || {};
        if (info.status === 'rejected') {
          showToast(`已触发速率限制（${info.rateLimitType || 'unknown'}）`, 'error');
        } else if (info.status === 'allowed_warning') {
          const pct = Math.round((info.utilization || 0) * 100);
          showToast(`接近速率限制：已用 ${pct}%`, 'warn');
        }
        break;
      }

      case 'run.status':
        if (isStale) break;
        // SDK 内部状态：'compacting' | 'requesting' | 'thinking' | null。
        // requesting 每个 LLM call 都触发，太频繁 → 跳过；只 toast compacting
        // （少见但耗时长，需要让用户知道"在压缩、不是卡住"）。
        // thinking = SDK 0.3 思考心跳（~1s 一条，带累计 tokens）——喂 ChatPanel
        // header 的"思考中"进度显示；事件本身也刷新 lastEventAt 让存活点保持绿色。
        if (evt.status === 'thinking') {
          setThinkingTokens(evt.tokens || 0);
        } else if (evt.status === 'compacting') {
          // SDK 自动压缩也走这条（手动 /compact 已在 handleCompact 里插过卡，这里幂等覆盖）
          upsertCompactCard('正在压缩上下文…\n历史会换成一份摘要，产物、任务文件和档案都不受影响。', true);
        }
        break;

      case 'run.system_init':
        if (isStale) break;
        // SDK 启动元信息：model / tools / mcp_servers / agents
        setProjectSystemInfo(id, evt.info);
        break;

      case 'run.context_usage': {
        if (isStale) break;
        // A2.1 后端 loop.js 每个 assistant message 后推一次。
        // 整条 evt 已是 ContextMeter 期望的 liveUsage 形态（events.js
        // Events.contextUsage 已轻量化）。merge 而非 replace —— partial event 缺字段时不
        // 覆盖已有值（用户反馈"动不动丢失信息"，根因是直接 replace 把上次的 messageBreakdown
        // 等慢字段清掉了）。
        mergeProjectContextUsage(id, evt);
        // A2.3：autoCompact 阈值预警。当 totalTokens >= 90% threshold 时
        // toast 提示"快压缩了"。compactWarnedRef 防止同一轮重复 toast；
        // 真 compact_boundary 触发时 reset，让下一段可以再次预警。
        if (evt.isAutoCompactEnabled && evt.autoCompactThreshold && evt.totalTokens) {
          const ratio = evt.totalTokens / evt.autoCompactThreshold;
          if (ratio >= 0.9 && !compactWarnedRef.current) {
            compactWarnedRef.current = true;
            const remainingK = ((evt.autoCompactThreshold - evt.totalTokens) / 1000).toFixed(0);
            showToast(
              `⚠ 上下文接近自动压缩阈值（${(ratio * 100).toFixed(0)}%），剩 ${remainingK}k tokens`,
              'error',  // 用 error kind 拿橙红色配色凸显严重性
            );
          }
        }
        break;
      }

      case 'run.prompt_suggestion':
        if (isStale) break;
        // 每轮后预测的下条 prompt（C19 SuggestionChip 消费）
        setPromptSuggestion(evt.suggestion);
        break;

      case 'run.task.started':
        if (isStale) break;
        // C28：把 task 元信息绑到 main agent 的 Task tool message ——
        // Message.jsx 的时间轴抽屉行（BRIEF / 30s 摘要流水 / 结果）吃这些字段。
        // 这是子代理动态在 UI 上的唯一入口（2026-08-18 拍板：侧栏 tabs、
        // 舞台便利贴、在场徽记全退役，动态收进对话时间轴）。
        if (evt.toolUseId) {
          setMessages(prev => prev.map(m =>
            m.role === 'tool' && m.id === evt.toolUseId
              ? {
                  ...m,
                  taskId: evt.taskId,
                  agentType: evt.subagentType || evt.taskType,
                  taskDescription: evt.description,
                  taskStatus: 'running',
                }
              : m,
          ));
        }
        break;

      case 'run.task.progress':
        if (isStale) break;
        // subagent 30s 摘要（ChatPanel header progress chip 消费）+ 同步到 Task tool message
        setAgentProgress({
          taskId: evt.taskId,
          description: evt.description,
          summary: evt.summary || null,
          lastTool: evt.lastToolName || null,
        });
        if (evt.toolUseId) {
          setMessages(prev => prev.map(m =>
            m.role === 'tool' && m.id === evt.toolUseId
              ? {
                  ...m,
                  taskSummary: evt.summary,
                  taskLastTool: evt.lastToolName,
                  // 时间轴抽屉（2026-07-30）：30s 摘要不再只留最后一条，全程累积
                  ...(evt.summary ? {
                    taskSummaryLog: [...(m.taskSummaryLog || []), evt.summary].slice(-20),
                  } : {}),
                }
              : m,
          ));
        }
        break;

      case 'run.task.notification':
        if (isStale) break;
        // subagent 完成 / 失败 / 停止 → 更新对应 Task tool message status
        setAgentProgress(null);
        if (evt.toolUseId) {
          setMessages(prev => prev.map(m =>
            m.role === 'tool' && m.id === evt.toolUseId
              ? {
                  ...m,
                  taskStatus: evt.status,           // 'completed' | 'failed' | 'stopped'
                  taskSummary: evt.summary,
                }
              : m,
          ));
        }
        if (evt.status === 'failed') {
          showToast(`子代理失败：${evt.summary || ''}`, 'error');
        } else if (evt.status === 'stopped') {
          showToast('子代理已停止', 'info');
        }
        break;

      case 'run.tool_progress':
        if (isStale) break;
        // 工具执行 >1s 时定期推 → 写到对应 tool message 的 elapsed 字段
        // C23 Message ToolMessage 渲染 "· 12s" 在工具调用 chip 旁边
        if (evt.blockId) {
          setMessages(prev => prev.map(m =>
            m.role === 'tool' && m.id === evt.blockId
              ? { ...m, elapsed: evt.elapsedSeconds }
              : m,
          ));
        }
        break;

      case 'run.bash_blocked':
        if (isStale) break;
        // C25：PreToolUse hook 拦了一条 Bash —— 用 system role 区分自 assistant 消息
        setMessages(prev => [...prev, {
          id: newId('msg'),
          role: 'system',
          variant: 'warn',
          content: `Bash 命令被拦截：${evt.command || ''}\n${evt.reason || '不在白名单'}`,
        }]);
        break;

      case 'run.screenshot_taken':
        if (isStale) break;
        // MCP screenshot_canvas 调用成功（agent 在自检）
        showToast('agent 正在视觉自检', 'info');
        break;

      case 'project.renamed': {
        // 首轮跑完服务端用会话摘要给项目正名（首页大输入框建的项目）
        if (evt.projectId && evt.projectId !== id) break;
        if (!evt.name) break;
        useProjectStore.getState().patchLocal?.(id, { name: evt.name });
        hydrateOne(id).catch(() => { /* 拉不到就等下次 */ });
        break;
      }

      case 'run.export_built':
        if (isStale) break;
        // MCP export_handoff 调用成功 —— agent 主动打了交付包
        showToast(`已打好源码包：${evt.path || ''}`, 'success');
        break;

      case 'run.download_ready': {
        // agent 交付（deliver_files / export_handoff）：直接进浏览器下载列表，
        // 用户不用再去导出菜单里翻。同一个 url 只触发一次（WS 重放会重复推）。
        if (isStale) break;
        if (!evt.url) break;
        if (deliveredRef.current.has(evt.url)) break;
        deliveredRef.current.add(evt.url);
        try {
          const a = document.createElement('a');
          a.href = evt.url;
          a.download = evt.filename || '';
          document.body.appendChild(a);
          a.click();
          a.remove();
          showToast(`agent 给了你 ${evt.filename}${evt.note ? ` · ${evt.note}` : ''}`, 'success');
        } catch (err) {
          showToast(`下载失败：${err.message}`, 'error');
        }
        break;
      }

      // （run.decision_recorded / run.compact_persisted 2026-08-24 拆除：
      //  决策贴与 spec.history 退役，事件已停发）

      case 'run.tweaks_exposed':
        if (isStale) break;
        // C5: agent 调 expose_tweaks 写 spec.tweaks → TweaksPanel reload schema
        setTweaksReloadKey(k => k + 1);
        setIsTweaksExposed(true);  // ChatPanel header 上显示打开按钮（PanelMenu 下架后唯一入口）
        showToast(`Tweaks 已更新（${evt.count} 个控件）`, 'info');
        break;

      case 'run.pending_changes_cleared': {
        // agent 调 clear_pending_changes 后，前端 comments state 同步移除 ——
        // 让橙色 overlay 标记跟 agent 处理行为对齐。不 guard isStale：哪怕事件来自
        // 上一 run（重连补推 / 慢推），buffer 文件已实际清掉，state 也该 sync。
        const cleared = Array.isArray(evt.clearedIds) ? evt.clearedIds : null;
        if (!cleared || cleared.length === 0) break;
        const set = new Set(cleared);
        setComments(prev => prev.filter(c => !set.has(c.id)));
        // 拖移工具产生的 pending edits 也按 clearedIds 同步移除
        pendingEditsHook.onAppliedExternally(cleared);
        break;
      }

      // C6: agent 的 navigate_to_page / highlight。实现在 lib/canvas-iframe-ops.js
      // （DOM 操作不该住在路由组件里）
      case 'run.canvas_navigate':
        if (!isStale) scrollToPage(evt.page);
        break;

      case 'run.canvas_highlight':
        if (!isStale) pulseHighlight(evt.selector, evt.durationMs);
        break;

      // 浏览器（2026-08-18）：agent 开始浏览 / 举手求助 —— 低频信号走这条 WS，
      // 像素和输入走专用通道 /ws/projects/:pid/browser
      case 'run.browser_opened':
        if (!isStale) setBrowseWin({ url: evt.url || null, help: null });
        // 桌面上那张浏览器卡也要跟着换页（它吃 GET /browse，靠 reload 拉）——
        // 不 bump 的话卡会一直停在上一页，直到别的什么事情触发了重拉
        if (!isStale) bumpListSoon();
        break;

      case 'run.browser_help':
        if (!isStale) setBrowseWin({ url: evt.url || null, help: evt.reason || '需要你帮个手' });
        break;

      case 'run.stop_reflection':
        // C6 Stop hook（占位，stage 1 不消费）
        break;

      // ── P1：Phase 1+2 漏接事件补齐 ──

      case 'run.tool_failure':
        if (isStale) break;
        // PostToolUseFailure hook → 让用户看到"哪个工具失败了"
        setMessages(prev => [...prev, {
          id: newId('msg'),
          role: 'system',
          variant: 'warn',
          content: `工具失败：${evt.toolName} — ${formatToolError(evt.error)}`,
        }]);
        break;

      case 'run.notification':
        if (isStale) break;
        // SDK / hook 主动 emit 的通知 → toast
        // priority 映射：error/high → error；success → success；其他 → info
        showToast(evt.text || '通知', mapNotificationKind(evt.priority));
        break;

      case 'run.compact_boundary': {
        if (isStale) break;
        // 上下文压缩边界 —— 让用户知道"agent 重新整理了上下文"
        // A2.3：升级提示带 pre/post token 数 + trigger（manual/auto）
        const meta = evt.compactMetadata;
        let msg = '上下文已自动压缩';
        if (meta?.pre_tokens && meta?.post_tokens) {
          const preK = (meta.pre_tokens / 1000).toFixed(0);
          const postK = (meta.post_tokens / 1000).toFixed(0);
          const trigger = meta.trigger === 'manual' ? '手动' : '自动';
          msg = `上下文已${trigger}压缩 ${preK}k → ${postK}k tokens`;
        }
        showToast(msg, 'info');
        upsertCompactCard(`${msg}。历史已换成摘要，产物和档案不受影响。`, false);
        // reset 预警 flag，下一段再次接近阈值时可以重新提示
        compactWarnedRef.current = false;
        break;
      }

      case 'run.api_retry': {
        if (isStale) break;
        // SDK API 重试（rate limit / server error 等）。
        // 多次重试用 fixed id 替换，避免刷屏。
        const text = `API 重试中（${evt.attempt}/${evt.maxRetries}）${evt.errorKind ? ` — ${evt.errorKind}` : ''}${evt.errorStatus != null ? ` HTTP ${evt.errorStatus}` : ''}`;
        setMessages(prev => {
          const idx = prev.findIndex(m => m.id === 'api-retry');
          const msg = { id: 'api-retry', role: 'system', variant: 'warn', content: text };
          if (idx >= 0) return [...prev.slice(0, idx), msg, ...prev.slice(idx + 1)];
          return [...prev, msg];
        });
        break;
      }

      case 'run.subagent.stop': {
        if (isStale) break;
        // S3b：子代理收尾结果挂回 Task 卡（纯消息变换，见 lib/chat-stream.js）
        setMessages(prev => attachSubagentResult(prev, evt));
        if (typeof window !== 'undefined' && import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.log(`[event] ${evt.type}`, evt);
        }
        break;
      }

      case 'run.image_generated': {
        if (isStale) break;
        // generate_image MCP 工具完成 → toast 提示。
        // 注：原 Phase Image-1 的自动 ImageApprovalBanner gate 已废弃（2026-05-06）—
        // generate_image CallToolResult 已返 image content block，前端 chat 自动渲染；
        // agent 在 caption 邀请反馈，用户下一轮 chat 即天然 gate。
        const role = evt.assetRole ? `[${evt.assetRole}] ` : '';
        showToast(`${role}已生成图片：${evt.path}`, 'success');
        // 图落盘后 reload iframe（2026-07-27）：骨架先行时 canvas 已引用了还没
        // 生成完的图，iframe 早于图完成加载到 404 裂图；codex 生图 45-60s 让这个
        // 窗口从"碰不到"变成"必碰"。file_changed 只在 canvas.html 写入时触发，
        // 这里补上"图完成也刷"。
        setFileVersions(prev => bumpFileVersion(prev, evt.absPath || evt.path));
        // 产物墙也当场重拉（2026-07-30）：服务端已经补发了 file_changed，这里再兜一道。
        // 之前只 bump reloadToken（那是 deck iframe 的 token，根本没传给 BoardCanvas），
        // 产物墙要等 run.done 的收尾刷新才拉到这张图 —— 用户看到的就是"图生成完了，
        // 但要等这一轮结束才出现在任务文件夹里"。
        bumpListSoon();
        break;
      }

      // agent 侧 pin_to_board 改了画布布局 → 整份布局重拉（不套 stale-run guard：
      // board 是 project 级状态，不属于某个 run）
      case 'board.updated': {
        setBoardVersion(v => v + 1);
        // 板书/草图的提示由 board.focus 那条带「看一眼」的接管（在视野里就不吵）
        if (evt.summary && !/板书|草图/.test(evt.summary)) showToast(`工作台：${evt.summary}`, 'info');
        break;
      }
      case 'board.focus': {
        if (evt.rect) setBoardFocus({ rect: evt.rect, tag: evt.tag || null, layer: evt.layer || '', soft: !!evt.soft, chalk: evt.chalk || null, at: Date.now() });
        break;
      }
      // agent 拨「改板书」开关（08-25）：BoardCanvas 挂窗口事件接（免 prop 钻五层）
      case 'ui.chalk_edit': {
        window.dispatchEvent(new CustomEvent('nd:chalk-edit', { detail: { on: !!evt.on } }));
        showToast(evt.on ? 'agent 打开了「改板书」：板书现在可以直接拖动/编辑' : 'agent 关上了「改板书」', 'info');
        break;
      }

      // Phase B 批次 3：SDK 自动 recall 写入 globalStore，MemoryCard 折叠区显示
      case 'run.memory_recall':
        if (isStale) break;
        useGlobalStore.getState().appendRecallHistory(id, {
          mode: evt.mode,
          memories: evt.memories,
          ts: evt.ts,
        });
        break;

      // Phase B 批次 4：MCP 工具 elicitInput 请求 → 弹 ElicitationModal
      // request 形如 { reqId, request: {...}, runId }
      case 'run.elicitation_request':
        if (isStale) break;
        setElicitRequest({ reqId: evt.reqId, request: evt.request, runId: evt.runId });
        break;

      // 运维 / 调试信号——不展示 UI，只 console 留痕（dev 模式）。
      // 这些事件用于排查问题，不该 spam 用户视图。
      case 'run.subagent.start':
      case 'run.session_state':
      case 'run.session_start':
      case 'run.files_persisted':
      case 'run.hook.started':
      case 'run.hook.response':
      case 'run.task.updated':
      case 'run.round.start':
      case 'run.round.end':
        if (typeof window !== 'undefined' && import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.log(`[event] ${evt.type}`, evt);
        }
        break;

      default:
        break;
    }
  }

  // ── early return ──
  if (!hydrated) {
    return (
      <AppShell breadcrumb={[{ label: '加载中...' }]}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          height: '60vh',
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.sub,
        }}>
          加载项目中…
        </div>
      </AppShell>
    );
  }
  if (hydrateError || !project) {
    return <NotFound id={id} error={hydrateError?.message} />;
  }

  // V2：TopBar status chip 整个去掉（用户反馈"运行中"/"上次失败"/"就绪"全违和）
  //   - running 由 ChatComposer 的 Send → 停止 按钮承担
  //   - failed 由 chat 内 ⚠️ inline assistant 消息承担
  //   - idle 没信息价值，删掉

  // ── handlers ──

  /**
   * ChatComposer send → POST /turn（流 A/C/B）
   * 把托盘里的 attachments（已上传成功的 asset）一起带；上传中 / 失败的不发。
   * send 成功后清空托盘。
   */
  const handleSend = async (text) => {
    // mime 字段必传：Phase 1.4 后端 image inline 检测用 mime 判断是不是图
    const attachments = inputs
      .filter(it => it.type === 'asset' && it.path)
      .map(it => ({ type: 'asset', path: it.path, name: it.name, size: it.size, mime: it.mime }));
    // 光有附件也算一条消息（2026-08-17，issue #1 第 8 条）。空文字 + 空托盘才是空消息。
    const body = (text || '').trim();
    if (!body && attachments.length === 0) return;
    // 任何一条消息发出去，攒着的元素评论就随行了（agent 每轮都拉 pending
    // changes）—— 标 sentAt 只为让「发给 agent（N 条标注）」那颗浮钮的计数
    // 归零，不影响橙色框（那个跟 status 走，agent clear 时才消）。
    setComments(arr => arr.some(c => !c.sentAt)
      ? arr.map(c => (c.sentAt ? c : { ...c, sentAt: Date.now() }))
      : arr);

    // Phase B 批次 3：用户主动 recall 的 project memory 拼到 chat 头部
    // <memory-recall> 包裹让 agent 知道这是用户主动注入的记忆而不是普通文本
    const pendingRecalls = useGlobalStore.getState().consumePendingMemoryRecalls();
    let chatWithRecalls = body;
    if (pendingRecalls.length > 0) {
      const recallBlocks = pendingRecalls.map(r => {
        const tag = r.agentType || 'main';
        return `<memory-recall agent="${tag}">\n${r.content}\n</memory-recall>`;
      }).join('\n\n');
      chatWithRecalls = `${recallBlocks}\n\n${body}`;
    }

    // 只发了附件的那条：气泡里得有东西，不然界面上是一个空框。写成附件名，
    // 跟托盘里刚消失的那几个 chip 对得上。
    const bubble = body || `（附件：${attachments.map(a => a.name || a.path).join('、')}）`;
    setMessages(ms => [...ms, { id: newId('msg'), role: 'user', content: bubble }]);
    try {
      // Phase A.1：优先用 ref 拿 sessionId，避开 React async 闭包陈旧。
      // 极快连发场景下 currentSessionId（useParams）还没刷过来，ref 已是最新。
      const sidForRequest = sessionIdRef.current ?? currentSessionId;
      const { runId, sessionId: returnedSid } = await Turn.send({
        pid: id,
        chat: chatWithRecalls,
        attachments,
        // S4：显式传选中的 sessionId；null 时后端识别为"新建 session"
        sessionId: sidForRequest,
        // 同上：已有会话时不带 model（真相在 session-config，picker 直接改那边）
        model: sidForRequest ? undefined : (useGlobalStore.getState().modelPref || undefined),
      });
      // 追加修（2026-08-05）：只有此刻没有 turn 在跑才立即认领新 runId。
      // agent 跑着时追加，服务端是把这条排进 inputQueue，当前流上的事件还都
      // 挂在老 runId 上 —— 这里要是抢先把 currentRunIdRef 换成排队那条的 id，
      // handleEvent 的 stale guard 会把老 turn 剩下的全部 delta/run.done 判成
      // 旧事件整段吞掉，表现就是"一追加，实时流当场冻住，只能刷新"。
      // 排队那条的认领交给它自己的 run.start（turn 边界晋升后服务端会发）。
      if (!currentRunIdRef.current) {
        currentRunIdRef.current = runId;
        setCurrentRunId(runId);  // 终止生成用
        setActiveRun({ pid: id, runId });  // A4.3：让 AskUserQuestionView 直 POST /answer
      }
      setInputs(arr => {  // 已发送的托盘清空（顺带回收图片预览的 objectURL）
        arr.forEach(it => { if (it.previewUrl) URL.revokeObjectURL(it.previewUrl); });
        return [];
      });
      // 起新 session 时立刻同步 ref + state —— 否则用户在第一 turn 跑完前发追加，
      // currentSessionId 还是 null 会被当新 session 起，跟原 session 脱钩。
      // ref 先行：下一条极快追加的 handleSend 不等 setState 那一拍。
      // （URL 不再动，服务端 turn 已把指针写到这条会话并广播）
      if (!sidForRequest && returnedSid) {
        sessionIdRef.current = returnedSid;
        setCurrentSessionId(returnedSid);
      }
    } catch (err) {
      // 429（额度用完 / 并发已满）和 451（内容外审拦截）不是故障，
      // 服务端的话术已经很白话，别再包一层"失败"
      const politeLimit = ['QUOTA_EXCEEDED', 'BUSY', 'MODERATION_BLOCKED', 'MODEL_LOCKED', 'MODEL_NOT_ALLOWED', 'LANE_SWITCH'].includes(err.code);
      // 403 MODEL_LOCKED（08-21）：选了 Pro 档才有的订阅模型 —— 弹框说清楚，并把偏好退回默认免费模型
      if (err.code === 'MODEL_LOCKED') {
        useGlobalStore.getState().setModelPref?.(null);
        useGlobalStore.getState().confirm?.({
          title: '这个模型仅限 Pro 档',
          message: `${err.message}\n\n模型选择器里带锁的那几档跑在站主的 Claude 订阅上，暂未对外开放；不带锁的随便选。`,
          confirmLabel: '知道了', cancelLabel: '关闭',
        });
      }
      setMessages(ms => [...ms, {
        id: newId('msg'),
        role: 'assistant',
        content: politeLimit ? `_${err.message}_` : `_⚠️ 发送失败：${err.message}_`,
      }]);
      showToast(politeLimit ? err.message : `发送失败：${err.message}`, politeLimit ? 'info' : 'error');
    }
  };
  // 让 handleApplyPendingEdits（在 early-return 之前定义）能查到本 closure 内最新
  // 的 handleSend。普通赋值，不是 hook，每次 render 重新指向当前 handleSend。
  handleSendRef.current = handleSend;

  /** streamInput 重构：用户主动结束当前 session（终结 query handle）
   *  - 调 close endpoint → backend inputQueue.close + abortController.abort
   *  - 本地清会话 + 清服务端指针（URL 已不承载会话，navigate 到 /work 清不掉了）
   *  - session JSONL 不删，从 SessionListModal 仍可找回（resume 走 forkSession）
   */
  const handleCloseSession = async () => {
    if (!currentSessionId) return;
    try {
      await Sessions.close(id, currentSessionId);
    } catch (err) {
      // close 失败不阻塞前端 — 本地照样清，让用户能继续
      console.warn('[Project] close session failed:', err.message);
    }
    setIsStreaming(false);
    setCurrentRunId(null);
    setActiveRun(null);
    sessionIdRef.current = null;
    setCurrentSessionId(null);
    updateProject(id, { activeSessionId: null });
  };

  /** 手动压缩上下文：raw 模式发 /compact 斜杠命令直达 SDK（跳过消息装饰，
      多包一层 system 注入 SDK 就不认命令了）。压缩过程走正常 run 生命周期。 */
  /**
   * 压缩提示卡（2026-07-28）：固定 id 的 system 消息，进行中转圈、结束换结果，
   * run 收尾时如果还挂着（压缩失败 / 没走到 boundary）就撤掉，不留一个转不停的圈。
   */
  // 注意：函数声明不是 hook —— 组件里有 loading / 未找到两处早返，
  // 用 useCallback 写在早返之后会让两次 render 的 hook 数不一致（React #310 白屏）。
  function upsertCompactCard(content, pending) {
    setMessages(prev => {
      const card = { id: 'compacting', role: 'system', variant: 'info', content, pending };
      const idx = prev.findIndex(m => m.id === 'compacting');
      if (idx === -1) return [...prev, card];
      const next = [...prev];
      next[idx] = card;
      return next;
    });
  }

  function dropPendingCompactCard() {
    setMessages(prev => (prev.some(m => m.id === 'compacting' && m.pending)
      ? prev.filter(m => m.id !== 'compacting')
      : prev));
  }

  const handleCompact = async () => {
    if (!currentSessionId || isStreaming) return;
    try {
      const r = await Turn.send({ pid: id, chat: '/compact', sessionId: currentSessionId, raw: true });
      setCurrentRunId(r.runId);
      setActiveRun({ runId: r.runId });
      setIsStreaming(true);
      // 左栏插一张进行中的卡：压缩要跑十几秒，只给一条 toast 用户会以为卡住了
      upsertCompactCard('正在压缩上下文…\n历史会换成一份摘要，产物、任务文件和档案都不受影响。', true);
    } catch (err) {
      showToast(`压缩失败：${err.message}`, 'error');
    }
  };

  /** 终止当前活跃 run（用户点 ChatPanel 的 Stop 按钮） */
  const handleStop = async () => {
    if (!currentRunId) return;
    try {
      await Turn.cancel({ pid: id, runId: currentRunId });
      // 真正的状态清理走 run.cancelled WS 事件（SDK abort 后端会 emit）
      // 这里只触发请求；UI 立即响应：currentRunId 暂不清，等事件回
    } catch (err) {
      if (err.code === 'RUN_NOT_ACTIVE') {
        // run 已结束（race：用户点的瞬间 agent 自然完成）
        setCurrentRunId(null);
        setActiveRun(null);
        setIsStreaming(false);
      } else {
        showToast(`取消失败：${err.message}`, 'error');
      }
    }
  };

  /**
   * 流 B：附件入托盘。File → 立即 push pending 占位 → Assets.upload → 拿到 path 后 patch
   * 失败：标记 error，留在托盘里让用户决定（删 / 重传）。
   *
   * 兼容：旧路径（InputsTab 的 handlePasteUrl / handleConnectRepo）传 metadata 对象，
   * 不是 File；直接 push 到托盘。这些 P0 不真发给 agent（attachments filter 只取
   * type=asset+path），P0+ 接通 URL ingest 时再扩展。
   */
  const handleAddInput = async (input) => {
    // metadata 对象（URL / repo）走原路径
    if (!(input instanceof File)) {
      setInputs(arr => [...arr, input]);
      return;
    }
    const tempId = newId('asset');
    // 图片在上传前就生成本地 objectURL —— 托盘缩略图不用等服务端，"上传中"
    // 也有图看。previewUrl 跟随 item 一生，移除 / 发送清托盘时 revoke。
    const previewUrl = (input.type || '').startsWith('image/')
      ? URL.createObjectURL(input) : undefined;
    setInputs(arr => [...arr, {
      id: tempId,
      type: 'asset',
      name: input.name,
      size: input.size,
      mime: input.type,
      previewUrl,
      // path: undefined → 渲染为 uploading
    }]);
    try {
      const { asset } = await Assets.upload(id, input);
      setInputs(arr => arr.map(it => it.id === tempId
        ? { ...it, path: asset.path, size: asset.size, name: asset.name, mime: asset.mime }
        : it,
      ));
    } catch (err) {
      setInputs(arr => arr.map(it => it.id === tempId
        ? { ...it, error: err.message }
        : it,
      ));
      showToast(`上传失败：${err.message}`, 'error');
    }
  };
  const handleRemoveInput = (assetId) => setInputs(arr => {
    const it = arr.find(a => a.id === assetId);
    if (it?.previewUrl) URL.revokeObjectURL(it.previewUrl);
    return arr.filter(a => a.id !== assetId);
  });

  /**
   * 流 E direct edit：bridge 在 blur 时已清 contentEditable=false（见 DirectEditBridge
   * cleanup() 在 onTextEdit 回调之前），此时 iframeDoc 是用户改过的最新最干净状态。
   *
   * 序列化整页 outerHTML（前缀 <!doctype html> 避免 doctype 丢失）→ PUT /canvas。
   * 不 bump reloadToken — iframe DOM 已经是最新，重 fetch 反而会闪一下还会丢用户操作焦点。
   */
  const handleTextEdit = async (info) => {
    setPatches(arr => [...arr, {
      id: newId('patch'),
      type: 'text-edit',
      anchor: info.anchor,
      oldValue: info.oldText,
      newValue: info.newText,
      ts: new Date().toISOString(),
    }]);
    if (!iframeDoc) {
      showToast('iframe 未就绪', 'error');
      return;
    }
    try {
      // 无会话闸门 2026-08-13 撤除：产物属于项目不属于会话，canvas 写入和
      // pending buffer 都已是项目级路由 —— 编辑不再要求先开一轮对话
      const html = '<!doctype html>\n' + iframeDoc.documentElement.outerHTML;
      await Canvas.write(id, html, 'user', info.deckPath || null);
      showToast(`已保存：「${info.newText.slice(0, 20)}」`, 'success');

      // C4：push 进 pending-changes buffer，下次发 chat 时 agent 主动拉
      try {
        const el = findElementByAnchor(info.anchor, iframeDoc.body);
        const aiContext = el ? serializeForAI(el) : null;
        await PendingChanges.push(id, {
          kind: 'edit',
          anchor: info.anchor,
          ...(info.deckPath ? { path: info.deckPath } : {}),
          aiContext,
          diff: { oldText: info.oldText, newText: info.newText },
        });
      } catch (err) {
        // buffer push 失败不影响主流程（落盘已成功）
        console.warn('[pending-changes] push edit failed:', err.message);
      }
    } catch (err) {
      showToast(`保存失败：${err.message}`, 'error');
    }
  };

  /**
   * 站点拖拽落盘（2026-07-29）：deck 的拖拽走 pending buffer 等 agent 应用；
   * 站点是我们自己的纯 HTML 文件，拖完的运行时 DOM 就是目标状态 ——
   * SiteWindow 序列化整页传上来，直接写回磁盘（跟双击改字同一条通道）。
   * records 是 FYI 记录（kind applied-*），push 进 buffer 只为让 agent 知道
   * 用户动过什么、必要时顺一下源码 —— 不需要它再应用一遍。
   * persist=false = React mount 区（运行时 DOM 动不得），照旧推 pending-* 等 agent 改 JSX。
   */
  const handleSiteDomEdit = async ({ path, html, summary, records = [], persist = true }) => {
    // （无会话闸门 2026-08-13 撤除 —— 理由见 handleTextEdit）
    try {
      if (persist) {
        if (!html) { showToast('页面未就绪，改动没保存', 'error'); return; }
        await Canvas.write(id, html, 'user', path);
        showToast(`已保存：${summary}`, 'success');
        // 用户通道的写没有 run.file_changed 事件（那是 agent PostToolUse 直发的），
        // 本地补一笔版本：让本页从干净磁盘态平滑重载（LiveFrame 换代 + 滚动保持），
        // 运行时里脚本注入的杂质顺便被冲掉，画面与文件重新对齐
        setFileVersions(prev => bumpFileVersion(prev, path));
      } else {
        showToast(`已记录：${summary}，发消息让 agent 落地`, 'info');
      }
      for (const r of records) {
        try {
          await PendingChanges.push(id, { ...r, path });
        } catch (err) {
          console.warn('[pending-changes] push site layout failed:', err.message);
        }
      }
    } catch (err) {
      showToast(`保存失败：${err.message}`, 'error');
    }
  };

  // C3 起：InspectFloatingCard 内嵌 textarea 直接传 ctx.text；老调用兼容 prompt
  const handleAddComment = async (ctx) => {
    let text = ctx?.text && ctx.text.trim();
    if (!text) {
      text = await prompt({
        title: '元素评论',
        message: '之后 AI 会按这条评论改它',
        placeholder: '描述要改的样子……',
        multiline: true,
      });
    }
    if (!text || !text.trim()) return;
    const trimmed = text.trim();
    // 前后端 id 统一——同一个 id 既挂前端 comments state（驱动橙色 overlay），
    // 也挂后端 pending-changes item.id。agent 调 clear_pending_changes 时 event
    // 带 clearedIds，前端按 id filter 移除对应橙色框。
    const cid = newId('cmt');
    setComments(arr => [...arr, {
      id: cid,
      anchor: ctx.anchor,
      aiContext: ctx.aiContext,
      // 站点评论带页面 path（tasks/<t>/about.html）—— agent 拉 buffer 时才知道
      // 评论挂在哪份文件上；deck 评论不带（默认当前 deck），行为不变
      ...(ctx.path ? { path: ctx.path } : {}),
      text: trimmed,
      status: 'open',
      createdAt: new Date().toISOString(),
    }]);
    // C4：push 进 pending-changes buffer。原来包着 `if (currentSessionId)` ——
    // 无会话时评论只剩本地橙框、agent 永远收不到（**静默丢失**）。buffer 已是
    // 项目级（2026-08-13），无条件推：第一条消息一发 agent 就能拉到。
    try {
      await PendingChanges.push(id, {
        id: cid,
        kind: 'comment',
        anchor: ctx.anchor,
        aiContext: ctx.aiContext,
        ...(ctx.path ? { path: ctx.path } : {}),
        text: trimmed,
      });
    } catch (err) {
      console.warn('[pending-changes] push comment failed:', err.message);
    }
  };
  /**
   * 圈选评论（2026-08-07）—— 跟点选评论进同一条 pending-changes buffer，
   * 差别是它多带一张服务端截的区域图。
   *
   * **发完直接起一轮**，不像点选评论那样只攒着等下一条消息：用户刚画完框、
   * 按了「发给 agent」，那个动作本身就是"现在就说这件事"。攒着不动的话
   * 他会以为没发出去。消息里只写一句指路，具体内容 agent 自己去
   * get_pending_changes 拉 —— 那边有图有元素清单，比塞进聊天里省得多。
   */
  const handleRegionComment = async ({ region, viewport, container, elements, text, path, docxPage }) => {
    // 无会话闸门 2026-08-13 撤除：没有会话时 handleSend 自己会起一条新的
    if (!path) {
      showToast('这份产物没有任务路径，圈选暂时用不了', 'error');
      return;
    }
    const rel = path;
    await PendingChanges.regionComment(id, {
      path: rel, region, viewport, container, elements, text,
      // docx 圈的是页图，得说清第几页（服务端按它去页图缓存裁）
      ...(docxPage ? { docxPage } : {}),
    });
    const what = docxPage ? `第 ${docxPage} 页`
      : elements.length
        ? `${elements.slice(0, 3).map(e => `<${e.tag}>`).join('')}${elements.length > 3 ? ' 等' : ''}`
        : '一块区域';
    useGlobalStore.getState().openChatDock();   // 对话在悬浮卡里流，收起时唤出来
    await handleSend(text
      ? `我在 ${rel} 上圈了一块（${what}）：${text}`
      : `我在 ${rel} 上圈了一块（${what}），看一下 —— 截图和框住的${docxPage ? '区域' : '元素'}都在 pending changes 里。`);
  };

  /**
   * 就地标注（2026-08-13，E3）：右键画布物件/文件夹 → 浮层写一句 → 直接起
   * 一轮。样板是 handleRegionComment（"用户刚按了发送，这个动作本身就是
   * 现在就说"），差别是它的载荷小（目标 + 一句话），直接进消息即可 ——
   * 不过 pending buffer，零新服务端面。id 就是工作区相对路径（画布 id=路径
   * 模型），agent 拿它能直接找到文件/文件夹；涂鸦手写这类原生物件的 id
   * 指向 board.json 条目，agent 也认得。
   */
  /**
   * 画布标注 → 直接起一轮。
   *
   * `targets`（框选之后批量标注）走同一条路：一条消息把这几件都点名，而不是
   * 发 N 条 —— 用户说的是"这几张一起改"，拆成 N 条 agent 就得猜它们之间的关系。
   */
  const handleAnnotate = async ({ target, targets, text, queue }) => {
    const list = targets?.length ? targets : [target];
    // 报**路径**不是 id：`deck:主稿.html` 这种带形态前缀的东西 agent 读不出来
    const whereOf = (t) => t.path || t.id;

    /**
     * 「攒着」：进 pending-changes buffer，右下角那条「发给 agent（N 条标注）」
     * 浮钮攒够了一次发（用户 2026-08-13 提）。
     *
     * **走的是元素标注那条现成的路**，不新开一条：同一个 buffer、同一条浮钮、
     * 同一个 `get_pending_changes`。画布标注和元素标注对 agent 来说是一回事
     * （"用户指着某个东西说了句话"），差别只在锚点粗细 —— 一个指到文件，
     * 一个指到文件里的某个元素。
     *
     * 锚点写 `{ board: id, path }`：`findElementByAnchor` 解不出它，所以产物窗
     * 里那圈橙色标记不会去画一个不存在的元素（那正是我们要的 —— 画布标注的
     * 视觉落点是卡片上的角标，不是文档里的框）。
     */
    if (queue) {
      for (const t of list) {
        const cid = newId('cmt');
        const item = {
          id: cid,
          kind: 'comment',
          anchor: { board: t.id, label: `${t.typeLabel}「${t.title}」` },
          path: whereOf(t),
          text,
        };
        setComments(arr => [...arr, {
          ...item, board: t.id, status: 'open', createdAt: new Date().toISOString(),
        }]);
        try {
          // eslint-disable-next-line no-await-in-loop
          await PendingChanges.push(id, item);
        } catch (err) {
          console.warn('[pending-changes] push board note failed:', err.message);
        }
      }
      showToast(`攒下了${list.length > 1 ? ` ${list.length} 条` : ''}，从下面那条浮钮一起发`, 'info');
      return;
    }

    // 直达角色：用户在某个常驻角色写的板书上回话，绕开主 agent（见 lib/role-direct.js）
    if (await trySayToRole({
      list, projectId: id, text, api: Assets, showToast,
      onSend: () => boardApiRef.current?.presenceHint?.(list[0].id),
    })) return;

    useGlobalStore.getState().openChatDock();
    // E4：发送瞬间精灵先飘到目标上（本地合成在场，真事件来了自然接管）
    boardApiRef.current?.presenceHint?.(list[0].id);
    const desc = list.map((t) => {
      const where = whereOf(t);
      const loc = where && where !== t.title ? `（${where}）` : '';
      // 板书/手写字带摘录与作者（2026-08-23）：用户在 agent 的字上回话，agent 得知道那段字
      // 说的是什么、是不是自己写的 —— 是自己的板书就用 write_on_board reply_to 接在下面
      // by 三类：'agent'（主控）/ 常驻角色 slug（rp-*）/ 其余按用户写的算。
      // ⚠️ 角色写的板书原来会落进 `t.chalk ? '用户写的'` 那一支 —— 判正好相反，
      // 主 agent 会以为那段字是用户写的。
      const isRole = !!t.by && t.by !== 'agent' && t.by !== 'user';
      const who = isRole ? `，${t.byName || t.by} 写的`
        : t.by === 'agent' ? '，agent 写的'
          : t.chalk ? '，用户写的' : '';
      const ex = t.excerpt ? `，原文「${t.excerpt}」` : '';
      const hint = t.chalk && (t.by === 'agent' || isRole) ? `；回应请 write_on_board reply_to=${t.path}` : '';
      return `${t.typeLabel}「${t.title}」${loc}${who}${ex}${hint}`;
    }).join('、');
    await handleSend(`【画布标注】${desc}：${text}`);
  };
  // 板书控件监听（early-return 之前那个 effect）要够到最新的 handleAnnotate
  handleAnnotateRef.current = handleAnnotate;

  /**
   * 「发给 agent（N 条标注）」浮钮（E3）：元素评论攒批后的空间确认按钮。
   * 消息只写一句指路 —— 内容和锚点 agent 自己去 pending changes 拉。
   */
  const unsentComments = comments.filter(c => c.status === 'open' && !c.sentAt);
  /**
   * 画布上每件东西攒了几条待发标注 → 卡片角标。
   *
   * 没有角标的话，「攒着」之后画布上一点痕迹都没有，只有右下角一个数字 ——
   * 走查到第五张时你已经不记得前面标过哪几张了。
   */
  // ⚠️ 不用 useMemo：这一段在**早退之后**（`unsentComments` 也是），加个 hook
  // 就等于"这次渲染比上次多调了一个 hook"，React 直接崩。一次遍历几条评论，
  // memo 省不出什么（2026-08-13 真跑撞到）。
  const boardNoteCounts = {};
  for (const c of unsentComments) if (c.board) boardNoteCounts[c.board] = (boardNoteCounts[c.board] || 0) + 1;
  const handleSendAnnotations = async () => {
    const n = unsentComments.length;
    if (!n) return;
    const paths = [...new Set(unsentComments.map(c => c.path).filter(Boolean))];
    const where = paths.length ? paths.join('、') : '打开的产物';
    // 措辞不写死"元素标注"：这条 buffer 现在同时装画布标注（指到一件东西）和
    // 元素标注（指到文档里的某个元素），说成一种会让 agent 去找不存在的元素
    const kindWord = unsentComments.every(c => c.board) ? '标注'
      : (unsentComments.some(c => c.board) ? '标注（有的指着画布上的东西，有的指着页面元素）' : '元素标注');
    useGlobalStore.getState().openChatDock();
    // sentAt 标记在 handleSend 开头统一做
    await handleSend(`我在 ${where} 上留了 ${n} 条${kindWord}，内容和锚点都在 pending changes 里，逐条处理一下。`);
  };

  const handleJumpToComment = (comment) => {
    if (!iframeDoc) return;
    const el = findElementByAnchor(comment.anchor, iframeDoc.body);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setSelectedAnchor(comment.anchor);
    } else {
      showToast('元素已不存在', 'error');
    }
  };
  const handleResolveComment = (cid) => {
    setComments(arr => arr.map(c =>
      c.id === cid ? { ...c, status: c.status === 'resolved' ? 'open' : 'resolved' } : c,
    ));
  };
  const handleDeleteComment = (cid) => {
    setComments(arr => arr.filter(c => c.id !== cid));
  };
  const handleDirectEdit = (ctx) => {
    setDirectEditAnchor(ctx.anchor);
    setDirectEditOpen(true);
  };
  const handleApplyDirectEdit = ({ anchor, changes }) => {
    setPatches(arr => [...arr, {
      id: newId('patch'),
      type: 'attr',
      anchor,
      changes,
      ts: new Date().toISOString(),
    }]);
    showToast(`已应用（P0 中：D 流真接留 P0+）`, 'info');
  };
  const handleTriggerRun = (ctx) => {
    const ai = ctx.aiContext;
    const tag = ai?.tag || 'element';
    const pageInfo = ai?.pageInfo;
    const pagePart = pageInfo?.index != null ? `第 ${pageInfo.index} 页` : '';
    const draft = `针对 ${pagePart}的 <${tag}>：\n\n…`;
    setChatDraft(draft);
    showToast('已填回对话框，编辑后发送', 'info');
  };

  // ── 顶栏 actions（async store ops）──
  const handleRename = async () => {
    setActionsOpen(false);
    const next = await prompt({
      title: '重命名项目',
      initialValue: project.name,
      placeholder: '项目名',
      validate: (v) => v.trim() ? null : '不能为空',
    });
    if (!next || !next.trim() || next === project.name) return;
    try {
      await updateProject(project.id, { name: next.trim() });
      showToast(`已重命名为「${next.trim()}」`, 'success');
    } catch (err) {
      showToast(`重命名失败：${err.message}`, 'error');
    }
  };
  const handleDuplicate = async () => {
    setActionsOpen(false);
    try {
      const copy = await duplicateProject(project.id);
      if (copy) {
        showToast(`已复制为「${copy.name}」（P0 简版：新建空项目，没复制 canvas）`, 'success');
        navigate(`/projects/${copy.id}`);
      }
    } catch (err) {
      showToast(`复制失败：${err.message}`, 'error');
    }
  };
  const handleDelete = async () => {
    setActionsOpen(false);
    if (!(await confirm({
      title: '删除项目',
      message: `删除「${project.name}」？此操作不可撤销。`,
      confirmLabel: '删除',
      danger: true,
    }))) return;
    try {
      await deleteProject(project.id);
      showToast('项目已删除', 'info');
      navigate('/');
    } catch (err) {
      showToast(`删除失败：${err.message}`, 'error');
    }
  };
  const handleViewCode = () => {
    setActionsOpen(false);
    showToast('spec.json 在 workspace 里，面板还没接真数据', 'info');
  };

  // ── snapshot / candidate handlers（P0 占位，noop）──
  const handleSaveSnapshotQuick = () => {
    setActionsOpen(false);
    showToast('快照 = git history（P0 用 git，UI 入口 C9 加）', 'info');
  };
  const handleOpenSnapshots = () => {
    setActionsOpen(false);
    setSnapshotOpen(true);
  };
  const handleSnapshotSave = () => showToast('P0+：用 git history 取代', 'info');
  const handleSnapshotRestore = () => showToast('P0+：git checkout', 'info');
  const handleSnapshotDelete = () => {};
  const handleSnapshotRename = () => {};

  const handleAddCandidate = () => showToast('P0+：candidate 由 agent fork_variant 主动开', 'info');
  const handleRemoveCandidate = () => {};
  const handleRenameCandidate = () => {};
  const handleSelectCandidate = () => setSelectedAnchor(null);

  /** 顶栏导出：格式怎么分流由 card-export.js 的表定。⚠️ `cardId` 由**产物窗自己
   *  报上来**——`boardUi.artifactCardId` 只在文件夹窗有值且取的是里头第一份，
   *  少了它窗内导出会提示「先点开那份产物」（他正开着）或导出错的一份 */
  const handleExport = (format, cardId = null) =>
    exportFromMenu(id, format, cardId || boardUi?.artifactCardId || null, project.name);

  return (
    <PanelManagerProvider projectId={id} defaultPanels={defaultPanels} panelMeta={panelMeta}>
    <AppShell
      // 工作台顶栏浮在画布之上、鼠标离开就淡出：画布是这里唯一的内容，
      // 横带越少越好。**浮起来而不是收起高度**——顶栏一参与布局，收展就会
      // 改画布容器高度，相机可视区跟着变、contain 重算，画面会跳。
      overlayTop
      // 顶栏不浮现的两种处境：产物窗开着（屏幕被一件产物占满，08-13）、聊天卡
      // 开着（卡贴右缘从屏顶铺到屏底，顶栏一浮出来就压住它顶沿那排按钮）。
      // 两层界面轮流占屏不叠着抢 —— 08-17 拍板，配套把卡的出厂默认从「固定
      // 展开」翻成「不固定」，否则顶栏等于没了。
      topSuppressed={artifactWindowOpen || chatDockOpen}
      /**
       * 文件夹窗开着 = 右上角有它的关闭叉。产物窗那条路是整条顶栏不浮现
       * （topSuppressed），文件夹窗不能照办 —— 下面那串面包屑**只有文件夹窗
       * 开着时才有内容**，收掉顶栏等于把换层的入口一起收掉。所以只让开右上角
       * 那一段感应带。issue #1 第 4 条。
       */
      topRightSafe={!!boardUi?.cwd}
      /**
       * 面包屑 = **当前目录一路拆到根**（2026-08-13）。
       *
       * 以前这里最多两级（项目名 / 任务名），因为那时只有"在项目区"和"聚焦
       * 某一块区"两种状态。现在文件夹可以套文件夹，进到第三层就得能一眼看出
       * 自己在哪、还能点回去任意一级。
       *
       * 项目名那一级 = 根目录。点它回根，跟点 logo 回首页不是一回事。
       */
      breadcrumb={[
        {
          label: project.name,
          title: '回到桌面根',
          ...(boardUi?.cwd ? { onClick: () => boardApiRef.current?.goTo?.('') } : {}),
        },
        ...((boardUi?.crumbs || []).map((c, i, all) => ({
          label: c.title,
          // 最后一级是"你现在在这儿"，不可点
          ...(i < all.length - 1 ? { onClick: () => boardApiRef.current?.goTo?.(c.id) } : {}),
        }))),
      ]}
      actions={
        <>
          {/* 顶栏只留导航和动作两类（2026-07-30 重构）。原来这里还挂着上下文进度条 +
              model + 5 个会话常量 chip + 刷新 + 压缩 + 分享，一行 21 个元素。
              上下文属于「这次对话」不属于项目，整组挪进聊天栏 composer 上沿；
              刷新进 ⋯，分享进导出菜单。留驻判据：每周会主动点的才配占常驻像素。 */}
          <div style={{ position: 'relative' }}>
            <button
              ref={exportBtnRef}
              style={primaryBtnStyle}
              onClick={() => { setExportOpen(v => !v); setActionsOpen(false); }}
            >
              <Download size={13} /> 导出
            </button>
            <ExportMenu
              open={exportOpen}
              onClose={() => setExportOpen(false)}
              projectId={id}
              onPickType={(t) => { setPickType(t); setPickExportOpen(true); }}
              onOpenList={() => setExportsListOpen(true)}
              onShare={() => setShareOpen(true)}
              anchorRef={exportBtnRef}
            />
          </div>
          <div style={{ position: 'relative' }}>
            <button
              ref={actionsBtnRef}
              style={iconBtnStyle}
              onClick={() => { setActionsOpen(v => !v); setExportOpen(false); }}
            >
              <MoreHorizontal size={14} />
            </button>
            <ProjectActionsMenu
              open={actionsOpen}
              onClose={() => setActionsOpen(false)}
              anchorRef={actionsBtnRef}
              onReload={() => { setActionsOpen(false); boardApiRef.current?.reload(); }}
              onRename={handleRename}
              onDuplicate={handleDuplicate}
              onDelete={handleDelete}
              onSaveSnapshot={handleSaveSnapshotQuick}
              onOpenSnapshots={handleOpenSnapshots}
              snapshotCount={(project.snapshots || []).length}
              onViewCode={handleViewCode}
              isQuickProject={project.kind === 'quick'}
              onUpgrade={() => { setActionsOpen(false); setUpgradeOpen(true); }}
              onOpenProjectPanel={(key) => boardApiRef.current?.openProjectPanel(key)}
              projectBand={boardUi?.projectBand || null}
            />
          </div>
        </>
      }
    >
      {/* 主区一层：画布占满全屏，聊天栏浮在它之上（2026-08-07 外壳改制）
       *
       * 原来是「左 360px 固定 chat + 右 canvas」两栏。改的理由是画布成了唯一
       * 顶层曲面，固定侧栏等于在最值钱的横向空间上永久收 360px 的税，而
       * DESKTOP_W=1360 这个逻辑宽当初就是照着"旁边有侧栏"定的。
       *
       * **「跟随镜头」是靠层级实现的，不是靠代码跟随**：聊天栏是这个视口容器的
       * absolute 子元素，跟画布内容的滚动/相机不在同一个坐标系里，所以画布怎么
       * 动它都待在屏幕原处。将来换成真相机（无限画布）也一样成立 —— 它在屏幕
       * 空间，不在画布空间。
       */}
      <div
        ref={stageAreaRef}
        style={{
          height: '100%', minHeight: 0,
          position: 'relative',
          background: STAGE.bg,
          overflow: 'hidden',
        }}
      >
        {/* 画布：铺满整个视口容器，边到边。
         *
         * `isolation:'isolate'` 是有用的：它把画布里的一切（世界层、关系线、
         * 在场标记、打开的产物窗）关进自己的层叠上下文，于是**浮窗层永远在
         * 产物窗之上** —— 打开一个 deck 还能跟 agent 说话，而那是这个工具的
         * 全部意义。不隔离的话，产物窗那个 z-index 500 会跟聊天栏的 120 在
         * 同一个上下文里比大小，把聊天盖死。 */}
        <section style={{
          position: 'absolute', inset: 0,
          display: 'flex', flexDirection: 'column',
          background: COLOR.bgWhite,
          isolation: 'isolate',
        }}>
          <CanvasFrame
            htmlSrc={currentSessionId ? Canvas.artifactUrl(id, versionOfFile(fileVersions, 'canvas.html')) : null}
            selectedAnchor={selectedAnchor}
            onSelectChange={setSelectedAnchor}
            onTextEdit={handleTextEdit}
            onIframeReady={handleIframeReady}
            candidates={project.candidates || []}
            activeCandidateId={project.activeCandidateId}
            onSelectCandidate={handleSelectCandidate}
            onAddCandidate={handleAddCandidate}
            onRemoveCandidate={handleRemoveCandidate}
            onRenameCandidate={handleRenameCandidate}
            project={project}
            deckSpec={deckSpec}
            projectId={id}
            sessionId={currentSessionId}
            browseWin={browseWin} onBrowse={setBrowseWin}
            // 产物窗只吃**元素标注**：画布标注的锚点是一件东西不是一个元素，
            // 混进去会让窗里的「评论 (N)」多算，也会让标记层拿着 {board:…}
            // 去 querySelector（anchor.path 那一支正好是选择器串，`鉴赏页` 这种
            // 路径进去就是个无效选择器）。它们的视觉落点是卡片角标，见 NoteBadge
            comments={comments.filter(c => !c.board)}
            boardNoteCounts={boardNoteCounts}
            onAnnotate={handleAnnotate}
            // 精灵对话通道（2026-08-14）：星芒下写的一句原样进会话 —— 跟聊天框
            // 同一条 handleSend，跑动中自然是追加/排队语义。刻意**不**开聊天抽屉：
            // 日记本范式的回条是精灵手写短句，全文想看再自己开侧栏
            onSpriteSay={(text) => handleSend(text)}
            onAddComment={handleAddComment}
            onResolveComment={handleResolveComment}
            onDeleteComment={handleDeleteComment}
            onRegionComment={handleRegionComment}
            onSiteDomEdit={handleSiteDomEdit}
            onDirectEdit={handleDirectEdit}
            onTriggerRun={handleTriggerRun}
            tweaksAvailable={isTweaksExposed}
            pendingEdits={pendingEditsHook.edits}
            onCommitMove={handleCommitMove}
            onCommitFreePosition={handleCommitFreePosition}
            onSubmitDragNote={handleSubmitDragNote}
            lastPendingEditId={lastPendingEditId}
            onApplyPendingEdits={handleApplyPendingEdits}
            onUndoPending={pendingEditsHook.undo}
            onClearAllPending={pendingEditsHook.clearAll}
            canUndoPending={pendingEditsHook.canUndo}
            isStreaming={isStreaming}
            artifactRefreshToken={listVersion}
            fileVersions={fileVersions}
            boardVersion={boardVersion}
            boardFocus={boardFocus}
            boardUi={boardUi}
            boardApiRef={boardApiRef}
            onBoardUiState={setBoardUi}
            onWindowOpenChange={setArtifactWindowOpen}
            onExport={handleExport}
            stageRef={stageRef}
            onAddToContext={(item) => {
              // 工作台物件 → 上下文托盘（同上传附件语义，下一条消息带给 agent）。
              // 按 path 去重防重复点击堆积。
              setInputs(prev => prev.some(it => it.path === item.path) ? prev : [...prev, item]);
              showToast(`已加入上下文：${item.name}（发消息时一起带给 agent）`, 'success');
            }}
            onAskAgent={(ctx) => {
              // 画布里的 agent 入口（2026-08-08）：画布只说「用户指着这里」，
              // 翻译成人话是这里的事 —— 画布不该知道聊天栏长什么样。
              //
              // **不替他把话说完**：只垫一句定位，光标停在后面等他写要做什么。
              // 自动填一整句会变成"猜他想干嘛"，猜错了他还得先删掉。
              // 复用既有的注入通道（Inspect「触发新 run」走的也是它）：
              // 写进 chatDraft，ChatComposer 会同步进 textarea 并把光标放到末尾。
              const lead = ctx?.objects?.length
                ? `关于「${ctx.objects.map(id => id.split('/').pop()).join('、')}」，`
                : ctx?.folder ? `在「${ctx.folder.split('/').pop()}」文件夹里，` : '';
              if (lead) useGlobalStore.getState().setChatDraft(lead);
              useGlobalStore.getState().focusComposer();
            }}
          />

        </section>

        {/* Tweaks 浮窗跟聊天栏一样住在画布 section **外面**：它是用来调正在看的
            那个 deck 的，被产物窗盖住就等于没有。
            C3：inspect / comments 删 — 改用 InspectFloatingCard（CanvasFrame 内贴选中元素） */}
        <FloatingPanel id="tweaks" title="Tweaks" icon={Sliders} bodyStyle={{ padding: 0 }}>
          <TweaksPanel
            projectId={id}
            sessionId={currentSessionId}
            iframeDoc={iframeDoc}
            reloadKey={tweaksReloadKey}
            onChat={handleSend}
          />
        </FloatingPanel>

        {/* 「发给 agent（N 条标注）」—— 元素评论攒批后的空间确认按钮（E3）。
            跟悬浮卡一样住在隔离层**外面**：标注多半是在产物窗里点的，
            按钮被窗盖住等于没有。有未发标注才出现。 */}
        {unsentComments.length > 0 && (
          <button
            onClick={handleSendAnnotations}
            style={{
              position: 'absolute', bottom: 64, left: '50%', transform: 'translateX(-50%)',
              zIndex: 130,
              display: 'inline-flex', alignItems: 'center', gap: GAP.sm,
              padding: `${GAP.sm}px ${GAP.lg}px`,
              border: 'none', borderRadius: RADIUS.md, cursor: 'pointer',
              background: INK_SURFACE.bg, color: INK_SURFACE.text,
              boxShadow: INK_SURFACE.shadow,
              fontFamily: FONT_KAI, fontSize: FONT_SIZE.md, letterSpacing: '0.04em',
              animation: 'ndPopIn 160ms cubic-bezier(0.32, 0.72, 0, 1)',
            }}
            title="agent 会去 pending changes 里逐条读你的标注"
          >
            <MessageSquarePlus size={14} strokeWidth={1.75} />
            发给 agent（{unsentComments.length} 条标注）
          </button>
        )}

        {/* 对话 —— 悬浮 AI 卡（2026-08-13）：关着零遮挡，鼠标贴屏缘唤出，
            图钉固定。放在 canvas section **之外**、视口容器之内：它跟画布
            内容不共用坐标系，画布怎么滚它都待在屏幕原处（这就是「跟随镜头」）。 */}
        <ChatDock title={currentSessionTitle || '对话'} onOpenChange={setChatDockOpen}>
          {({ collapse, pinned, onTogglePin }) => (
          <ChatPanel
            onCollapse={collapse}
            pinned={pinned}
            onTogglePin={onTogglePin}
            messages={messages}
            onSend={handleSend}
            isStreaming={isStreaming}
            roleStage={roleStage}
            roleNames={roleNames}
            queueDepth={queueDepth}
            wsStatus={wsStatus}
            lastEventAt={lastEventAt}
            trayItems={inputs}
            onRemoveTrayItem={handleRemoveInput}
            onPickFile={handleAddInput}
            promptSuggestion={promptSuggestion}
            onDismissSuggestion={() => setPromptSuggestion(null)}
            agentProgress={agentProgress}
            thinkingTokens={thinkingTokens}
            onStop={currentRunId ? handleStop : null}
            sessionTitle={currentSessionTitle}
            onOpenSessionList={() => setSessionListOpen(true)}
            onCloseSession={handleCloseSession}
            onNewChat={() => {
              // 新对话 = 清指针（本地即时 + 服务端广播，别的标签页跟着走）
              sessionIdRef.current = null;
              setCurrentSessionId(null);
              updateProject(id, { activeSessionId: null });
            }}
            hasActiveSession={!!currentSessionId}
            systemInfo={systemInfo}
            contextUsage={contextUsage}
            onCompact={handleCompact}
            onRefreshUsage={refreshContextUsage}
            projectId={id}
            sessionId={currentSessionId}
            onCanvasReload={handleCanvasReload}
          />
          )}
        </ChatDock>
      </div>

      <ShareModal show={shareOpen} onClose={() => setShareOpen(false)} project={project} />
      <ExportPicker
        open={pickExportOpen}
        onClose={() => setPickExportOpen(false)}
        projectId={id}
        initialType={pickType}
        onToast={showToast}
      />

      <ExportsListModal
        show={exportsListOpen}
        onClose={() => setExportsListOpen(false)}
        projectId={id}
        sessionId={currentSessionId}
      />
      <SnapshotModal
        show={snapshotOpen}
        onClose={() => setSnapshotOpen(false)}
        project={project}
        onSave={handleSnapshotSave}
        onRestore={handleSnapshotRestore}
        onDelete={handleSnapshotDelete}
        onRename={handleSnapshotRename}
      />
      <DirectEditModal
        show={directEditOpen}
        onClose={() => setDirectEditOpen(false)}
        anchor={directEditAnchor}
        iframeDoc={iframeDoc}
        onApply={handleApplyDirectEdit}
      />
      <SessionListModal
        show={sessionListOpen}
        onClose={() => setSessionListOpen(false)}
        projectId={id}
        currentSessionId={currentSessionId}
        onSwitch={(sid) => {
          // 切会话 = 改服务端指针（唯一真相源），本地先行、WS 重连自动重 hydrate。
          // 以前这里 navigate 到 /sessions/:sid —— URL 真相源时代的舞蹈，已收敛。
          sessionIdRef.current = sid || null;
          setCurrentSessionId(sid || null);
          updateProject(id, { activeSessionId: sid || null });
        }}
      />
      {elicitRequest && (
        <ElicitationModal
          projectId={id}
          request={elicitRequest}
          onClose={() => setElicitRequest(null)}
        />
      )}
      <UpgradeQuickModal
        show={upgradeOpen}
        onClose={() => setUpgradeOpen(false)}
        project={project}
        onUpgraded={(updated) => {
          showToast(`已升级为标准项目「${updated.name}」`, 'success');
        }}
      />

    </AppShell>
    </PanelManagerProvider>
  );
}

// ── helpers ──

/** 工具错误对象 → 用户可读字符串 */
function formatToolError(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

/** SDK notification priority → toast kind */
function mapNotificationKind(priority) {
  if (priority === 'error' || priority === 'high') return 'error';
  if (priority === 'success') return 'success';
  return 'info';
}

function NotFound({ id, error }) {
  return (
    <AppShell breadcrumb={[{ label: '未找到' }]}>
      <div style={{
        maxWidth: 600, margin: '0 auto', padding: `${GAP.page * 2}px ${GAP.page}px`,
        textAlign: 'center',
      }}>
        <h1 style={{
          fontFamily: FONT_KAI, fontSize: FONT_SIZE.h1, fontWeight: 700,
          color: COLOR.text, marginBottom: GAP.lg,
        }}>项目 <code style={{ color: COLOR.error }}>{id}</code> 不存在</h1>
        <p style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.lg, color: COLOR.sub, marginBottom: GAP.xl }}>
          {error || '可能 ID 写错了，或这个项目已被删除。'}
        </p>
        <Link to="/" style={{
          display: 'inline-block',
          padding: `${GAP.md}px ${GAP.xl}px`,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, fontWeight: 500,
          color: COLOR.btnText, background: COLOR.btn,
          borderRadius: RADIUS.lg,
        }}>返回首页</Link>
      </div>
    </AppShell>
  );
}

const iconBtnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  padding: `${GAP.xs + 1}px ${GAP.lg}px`,
  fontSize: FONT_SIZE.lg, color: CHROME.ink2,
  background: 'rgba(43,33,23,0.055)',
  borderRadius: RADIUS.md,
  border: 'none',
  cursor: 'pointer',
};

const primaryBtnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  padding: `${GAP.xs + 1}px ${GAP.lg}px`,
  fontSize: FONT_SIZE.lg, fontWeight: 700,
  color: COLOR.btnText, background: COLOR.btn,
  border: `1px solid ${COLOR.btn}`,
  borderRadius: RADIUS.md,
  cursor: 'pointer',
};

/**
 * 描述 pending edits 给 chat 的预设文案——给 agent 一个简短人话摘要
 * （详情还是要它调 get_pending_changes 拿）。
 */
function describeEditsForChat(edits) {
  const counts = { move: 0, dup: 0, style: 0, del: 0, reactHits: 0 };
  for (const e of edits) {
    if (e.kind === 'pending-move') counts.move++;
    else if (e.kind === 'pending-duplicate') counts.dup++;
    else if (e.kind === 'pending-style') counts.style++;
    else if (e.kind === 'pending-delete') counts.del++;
    if (e.reactMount) counts.reactHits++;
  }
  const parts = [];
  if (counts.move) parts.push(`${counts.move} 拖动`);
  if (counts.dup) parts.push(`${counts.dup} 复制`);
  if (counts.style) parts.push(`${counts.style} 样式`);
  if (counts.del) parts.push(`${counts.del} 删除`);
  let s = parts.join(' + ');
  if (counts.reactHits > 0) s += `；其中 ${counts.reactHits} 处涉及 React mount 区域，要改 <script id="__nd-app"> 里的 JSX`;
  return s || '若干调整';
}
