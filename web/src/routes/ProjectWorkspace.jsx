import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import { Share2, Download, MoreHorizontal } from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
// 主区两栏固定（左 chat + 右 canvas 占满）；5 个次级 UI = 浮窗 bounds=parent
// 限制在 canvas section 内（chat / canvas 不再可拖动 — PLAN.md:431 旧决策回归）。
import FloatingPanel from '../components/layout/FloatingPanel.jsx';
import { PanelManagerProvider } from '../components/layout/PanelManager.jsx';
import PanelMenu from '../components/layout/PanelMenu.jsx';
import { Sliders } from 'lucide-react';
import ChatPanel from '../components/chat/ChatPanel.jsx';
import CanvasFrame from '../components/canvas/CanvasFrame.jsx';
// InspectTab 由 InspectFloatingCard 间接使用（不在此处直接 import）
// CommentsTab 已删 — comments 嵌入到 InspectFloatingCard
// DecisionsTab / SystemTab 现在由 SystemPopover 间接使用（CanvasFrame 内）
// 不在此处直接 import — C2 撤销 floating panel 注册
import ShareModal from '../components/project/ShareModal.jsx';
import ExportMenu from '../components/project/ExportMenu.jsx';
import ProjectActionsMenu from '../components/project/ProjectActionsMenu.jsx';
import SnapshotModal from '../components/project/SnapshotModal.jsx';
import DirectEditModal from '../components/canvas/DirectEditModal.jsx';
import UndoButton from '../components/canvas/UndoButton.jsx';
import ContextUsageBar from '../components/project/ContextUsageBar.jsx';
import ExportsListModal from '../components/project/ExportsListModal.jsx';
import SessionListModal from '../components/project/SessionListModal.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO, STAGE } from '../lib/theme.js';
import { useProjectStore } from '../stores/projectStore.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { MOCK_DECK_SPEC } from '../mock/deck-spec.js';
import { newId } from '../lib/helpers.js';
import { findElementByAnchor } from '../lib/html-utils.js';
import { Canvas, Turn, Assets, Exports, Sessions } from '../lib/api.js';
import { openProjectWS } from '../lib/ws-client.js';
import { sessionMessagesToDisplay } from '../lib/session-to-messages.js';

export default function ProjectWorkspace() {
  // H1：URL 作为 session 唯一 source of truth
  //   - /projects/:id/work        → 无 sid（新会话）
  //   - /projects/:id/sessions/:sid → 带 sid（恢复某 session）
  // 切换 session 走 navigate；run.done 后若 url 没 sid（新会话刚跑完）
  // navigate replace 到 /sessions/<sid> 让 URL 反映真实 sid，刷新可恢复
  const { id, sid: urlSid } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const currentSessionId = urlSid || null;

  // ── store ──
  const project = useProjectStore(s => s.projects.find(p => p.id === id));
  const hydrateOne = useProjectStore(s => s.hydrateOne);
  const updateProject = useProjectStore(s => s.updateProject);
  const deleteProject = useProjectStore(s => s.deleteProject);
  const duplicateProject = useProjectStore(s => s.duplicateProject);
  const applyRunEvent = useProjectStore(s => s.applyRunEvent);
  const showToast = useGlobalStore(s => s.showToast);
  const setChatDraft = useGlobalStore(s => s.setChatDraft);
  // A4.3：维护活跃 run 的 (pid, runId)，让 AskUserQuestionView 能直接 POST /answer
  const setActiveRun = useGlobalStore(s => s.setActiveRun);

  // ── local state ──（所有 useState 必须在 early return 之前；hooks 顺序敏感）
  const [hydrated, setHydrated] = useState(false);
  const [hydrateError, setHydrateError] = useState(null);
  const [messages, setMessages] = useState([]);
  const [inputs, setInputs] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [selectedAnchor, setSelectedAnchor] = useState(null);
  const [iframeDoc, setIframeDoc] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);

  // ── P0+ s1 C17：SDK 高频事件提升的 state（被 C18/C19/C20 各组件消费）──
  // systemInfo: SDK 'system init' 事件（model / tools / mcp_servers / agents 元信息）
  // promptSuggestion: 每轮后 piggyback 预测的下条 prompt
  // agentProgress: subagent 30s 摘要（"正在分析颜色对比度…"）
  // P0+ s1 C23：toolElapsed 从单独 state 改为写到 message 对象的 elapsed 字段，
  // 消除 prop drilling，Message 组件直接读 message.elapsed。
  const [systemInfo, setSystemInfo] = useState(null);
  // A2.2：实时 context usage（run.context_usage 事件，每个 assistant 块更新）。
  // session 跨 turn 累积，run.start 不清零 —— 第一个 assistant 后会推新值
  // 自动 overwrite。换 session 时 SessionListModal/Hub 入口已重置整个组件。
  const [contextUsage, setContextUsage] = useState(null);
  const [promptSuggestion, setPromptSuggestion] = useState(null);
  const [agentProgress, setAgentProgress] = useState(null);
  // C29：DecisionsTab 自动刷新触发器（agent 调 record_decision / compact 后 bump）
  const [decisionsReloadKey, setDecisionsReloadKey] = useState(0);
  // 终止生成：当前活跃 run 的 id（Turn.send 返回时记，run.done/error/cancelled 清）
  const [currentRunId, setCurrentRunId] = useState(null);
  // SDK TodoWrite 工具的实时计划清单（run.todo.updated 推）
  // 新一轮 run.start 清空；done/cancelled/error 保留作"上一轮完成情况"
  const [todos, setTodos] = useState([]);
  // H1：currentSessionId 来自 URL（urlSid，已在 useParams 上面）
  // title 用 list session 后 match URL sid 拿到
  const [currentSessionTitle, setCurrentSessionTitle] = useState('');
  const [sessionListOpen, setSessionListOpen] = useState(false);

  const [shareOpen, setShareOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportsListOpen, setExportsListOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [directEditOpen, setDirectEditOpen] = useState(false);
  const [directEditAnchor, setDirectEditAnchor] = useState(null);
  const [patches, setPatches] = useState([]);     // P0 mock：D 流盲区，C7 真接
  const [comments, setComments] = useState([]);   // P0 mock：D 流不在范围
  const exportBtnRef = useRef(null);
  const actionsBtnRef = useRef(null);
  // A2.2b：autoCompact 阈值预警的"已警告"flag。同一轮接近阈值只 toast 一次，
  // 真 compact_boundary 触发时 reset 为 false（下一轮重新累积时可再次预警）。
  const compactWarnedRef = useRef(false);

  // ── memo / callback（必须在 early return 之前）──
  const deckSpec = useMemo(() => MOCK_DECK_SPEC, []);

  // 浮窗默认 layout —— chat / canvas 改回固定栏（不浮）；
  // 5 个次级 UI 仍是浮窗（bounds = canvas 容器），默认 hidden 按需 spawn。
  // position 是相对 canvas 容器的坐标系（不是 viewport）。
  // y 起点 64 = 避开 canvas toolbar（~44px）+ 留 20px 呼吸。
  // C2/C3：浮窗体系收口
  //  - system / decisions → toolbar Settings popover（C2）
  //  - inspect / comments → 选中元素自动弹的 contextual InspectFloatingCard（C3）
  //  - 仅 tweaks 保留 floating panel（C5 schema 驱动）
  const defaultPanels = useMemo(() => ({
    tweaks:    { position: { x: 96, y: 160 },  size: { width: 320, height: 360 }, visible: false, zIndex: 100 },
  }), []);

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

  // H1：拉 session 元信息更新 title（依赖 url sid + project ready）
  useEffect(() => {
    if (!hydrated || hydrateError || !project) return;
    if (!currentSessionId) {
      setCurrentSessionTitle('');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { sessions = [] } = await Sessions.list(id, { limit: 100 });
        if (cancelled) return;
        const match = sessions.find(s => s.sessionId === currentSessionId);
        if (match) setCurrentSessionTitle(match.customTitle || match.summary || '');
      } catch (err) {
        console.warn('[Project] list sessions failed:', err.message);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, hydrated, hydrateError, project?.id, currentSessionId]);

  // H1：hydrate session messages（依赖 url sid）
  useEffect(() => {
    if (!currentSessionId) {
      // /work 路径 = 新会话 → 空 chat 让用户从头开始
      setMessages([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { messages: sessionMsgs = [] } = await Sessions.read(id, currentSessionId);
        if (cancelled) return;
        const display = sessionMessagesToDisplay(sessionMsgs);
        setMessages(display);
      } catch (err) {
        console.warn('[Project] hydrate session messages failed:', err.message);
        setMessages([]);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, currentSessionId]);

  // ── open WS once project exists ──
  // 依赖 project?.id 而非整个 project 对象，避免 status patch 触发重连
  useEffect(() => {
    if (!hydrated || hydrateError || !project) return;
    const ws = openProjectWS({
      projectId: id,
      onEvent: (evt) => {
        applyRunEvent(id, evt);
        handleEvent(evt);
      },
    });
    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, hydrated, hydrateError, project?.id]);

  // ── H4a: auto-send initialMessage from location.state（HubInput 入口）──
  // Hub 用户在 input box 输入 → navigate('/work', { state: { initialMessage } })
  // 这里 mount 完毕 + project hydrated + WS 上线后自动发送一次，无感跳转。
  // 用 ref 防双发（StrictMode + state 闭包都可能触发重入）；发完 navigate
  // replace 清 state 防刷新重发。
  const initialMessageSentRef = useRef(false);
  useEffect(() => {
    if (!hydrated || hydrateError || !project) return;
    if (initialMessageSentRef.current) return;
    const initial = location.state?.initialMessage;
    if (typeof initial !== 'string' || !initial.trim()) return;
    initialMessageSentRef.current = true;

    const text = initial.trim();
    // 等 WS 连上一两个 tick 再发，确保 run.start 等事件能收到
    const t = setTimeout(async () => {
      setMessages((ms) => [...ms, { id: newId('msg'), role: 'user', content: text }]);
      try {
        const { runId } = await Turn.send({
          pid: id,
          chat: text,
          attachments: [],
          sessionId: currentSessionId,  // /work 路径 → null（新会话）；/sessions/:sid → 续约
        });
        setCurrentRunId(runId);
        setActiveRun({ pid: id, runId });  // A4.3：让 AskUserQuestionView 直 POST /answer
      } catch (err) {
        setMessages((ms) => [...ms, {
          id: newId('msg'), role: 'assistant',
          content: `_⚠️ 发送失败：${err.message}_`,
        }]);
        showToast(`发送失败：${err.message}`, 'error');
      }
      // 清 location.state 防 navigate 后退/刷新重发
      navigate(location.pathname, { replace: true, state: null });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, hydrateError, project?.id, location.state]);

  /** WS 事件 → chat messages / iframe reload 翻译层 */
  function handleEvent(evt) {
    switch (evt.type) {
      case 'run.start':
        setIsStreaming(true);
        setTodos([]);
        break;
      case 'run.todo.updated':
        setTodos(Array.isArray(evt.todos) ? evt.todos : []);
        break;
      case 'run.delta.text':
        setMessages(prev => appendTextDelta(prev, 'assistant', evt.text));
        break;
      case 'run.delta.thinking':
        setMessages(prev => appendTextDelta(prev, 'thinking', evt.text));
        break;
      case 'run.tool_use.started':
        // 工具 streaming 起点（SDK content_block_start 触发）。立即推 icon + name
        // 让用户看到"agent 在调 X 工具"，input 待 run.delta.tool_use 来时补。
        setMessages(prev => {
          // 防御：如果同 blockId 已经在（理论上不会，但 ws 重连重放可能），noop
          if (prev.some(m => m.role === 'tool' && m.id === evt.blockId)) return prev;
          return [...prev, {
            id: evt.blockId,
            role: 'tool',
            toolName: evt.name,
            toolInput: undefined,  // 还没流完
            status: 'running',
          }];
        });
        break;
      case 'run.delta.tool_use':
        // assistant message 完成时 SDK 推完整 tool_use block 来。如果同 blockId
        // 的 tool message 已存在（被 run.tool_use.started 推过），就 update input；
        // 否则补 push（兼容 SDK 没出 content_block_start 的情况，如某些 stream 边界）。
        setMessages(prev => {
          const existingIdx = prev.findIndex(m => m.role === 'tool' && m.id === evt.blockId);
          if (existingIdx >= 0) {
            const updated = [...prev];
            updated[existingIdx] = { ...updated[existingIdx], toolInput: evt.input };
            return updated;
          }
          return [...prev, {
            id: evt.blockId || newId('tool'),
            role: 'tool',
            toolName: evt.name,
            toolInput: evt.input,
            status: 'running',
          }];
        });
        break;
      case 'run.delta.tool_result':
        setMessages(prev => prev.map(m =>
          m.role === 'tool' && m.id === evt.blockId
            ? {
                ...m,
                status: evt.ok ? 'success' : 'error',
                toolOutput: evt.output,
                toolError: evt.error,
                // C24：image content blocks（screenshot_canvas 等返回的图片）
                toolImages: evt.images,
              }
            : m,
        ));
        break;
      case 'run.done':
        setIsStreaming(false);
        setCurrentRunId(null);
        setActiveRun(null);
        // 收尾：清 thinking 流式光标（run 结束后最后一条 thinking 不该一直闪）
        setMessages(prev => clearThinkingStreaming(prev));
        // 双保险：FileChanged hook（run.file_changed）应该已 bump 过 reloadToken
        // 但万一 hook 不触发（如 SDK 边角问题），这里兜底再 bump 一次
        setReloadToken(t => t + 1);
        // H1：从"新会话"（/work 路径）刚跑完 → SDK 已建新 sid → navigate
        // replace 到 /sessions/<sid>，让 URL 反映真实 sid（刷新可恢复，
        // SessionListModal 现在能高亮当前 session）
        if (!currentSessionId) {
          Sessions.list(id, { limit: 1 }).then(({ sessions = [] }) => {
            if (sessions.length > 0) {
              navigate(`/projects/${id}/sessions/${sessions[0].sessionId}`, { replace: true });
            }
          }).catch(() => { /* ignore */ });
        }
        break;
      case 'run.file_changed':
        // C4: FileChanged hook → 仅对 canvas.html / *.html 后缀触发 iframe reload
        // 其他文件（spec.json / assets/* / .git/*）忽略
        if (typeof evt.filePath === 'string'
            && (evt.filePath.endsWith('canvas.html') || evt.filePath.endsWith('.html'))) {
          setReloadToken(t => t + 1);
        }
        break;
      case 'run.error':
        setIsStreaming(false);
        setCurrentRunId(null);
        setActiveRun(null);
        setMessages(prev => [...clearThinkingStreaming(prev), {
          id: newId('msg'),
          role: 'assistant',
          content: `_⚠️ ${evt.message || '运行出错'}_`,
        }]);
        showToast(`运行失败：${evt.message || '未知错误'}`, 'error');
        break;
      case 'run.cancelled':
        setIsStreaming(false);
        setCurrentRunId(null);
        setActiveRun(null);
        setPromptSuggestion(null);
        setAgentProgress(null);
        setMessages(prev => clearThinkingStreaming(prev));
        showToast('已取消', 'info');
        break;

      // ── P0+ s1 C17：新事件类型 ──

      case 'run.system_init':
        // SDK 启动元信息：model / tools / mcp_servers / agents
        setSystemInfo(evt.info);
        break;

      case 'run.context_usage': {
        // A2.1 后端 loop.js 每个 assistant message 后推一次。
        // 整条 evt 已是 ContextUsageBar 期望的 liveUsage 形态（events.js
        // Events.contextUsage 已轻量化），直接 setState 即可。
        setContextUsage(evt);
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
        // 每轮后预测的下条 prompt（C19 SuggestionChip 消费）
        setPromptSuggestion(evt.suggestion);
        break;

      case 'run.task.started':
        // C28：把 task 元信息绑到 main agent 的 Task tool message
        // tool_use_id 关联 → 用户能在 Task chip 上看到 agentType / description
        if (evt.toolUseId) {
          setMessages(prev => prev.map(m =>
            m.role === 'tool' && m.id === evt.toolUseId
              ? {
                  ...m,
                  taskId: evt.taskId,
                  agentType: evt.taskType,
                  taskDescription: evt.description,
                  taskStatus: 'running',
                }
              : m,
          ));
        }
        break;

      case 'run.task.progress':
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
              ? { ...m, taskSummary: evt.summary, taskLastTool: evt.lastToolName }
              : m,
          ));
        }
        break;

      case 'run.task.notification':
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
        // C25：PreToolUse hook 拦了一条 Bash —— 用 system role 区分自 assistant 消息
        setMessages(prev => [...prev, {
          id: newId('msg'),
          role: 'system',
          variant: 'warn',
          content: `Bash 命令被拦截：${evt.command || ''}\n${evt.reason || '不在白名单'}`,
        }]);
        break;

      case 'run.screenshot_taken':
        // MCP screenshot_canvas 调用成功（agent 在自检）
        showToast('agent 正在视觉自检', 'info');
        break;

      case 'run.export_built':
        // MCP export_handoff 调用成功 —— agent 主动打了交付包
        showToast(`已生成交付包：${evt.path || ''}`, 'success');
        break;

      case 'run.decision_recorded':
        // MCP record_decision 调用成功 —— agent 沉淀了一条设计决策
        // 不弹 toast 避免噪音（agent 可能频繁调）；
        // 触发 DecisionsTab 自动刷新 + console 留痕
        setDecisionsReloadKey(k => k + 1);
        if (typeof window !== 'undefined') {
          // eslint-disable-next-line no-console
          console.log(`[decision] ${evt.title} (now ${evt.decisionsCount} decisions)`);
        }
        break;

      case 'run.compact_persisted':
        // PostCompact hook 写完 spec.json → DecisionsTab 也更新
        setDecisionsReloadKey(k => k + 1);
        showToast(`已沉淀 compact 摘要（${evt.summaryLength || '?'} chars）`, 'info');
        break;

      case 'run.stop_reflection':
        // C6 Stop hook（占位，stage 1 不消费）
        break;

      // ── P1：Phase 1+2 漏接事件补齐 ──

      case 'run.tool_failure':
        // PostToolUseFailure hook → 让用户看到"哪个工具失败了"
        setMessages(prev => [...prev, {
          id: newId('msg'),
          role: 'system',
          variant: 'warn',
          content: `工具失败：${evt.toolName} — ${formatToolError(evt.error)}`,
        }]);
        break;

      case 'run.notification':
        // SDK / hook 主动 emit 的通知 → toast
        // priority 映射：error/high → error；success → success；其他 → info
        showToast(evt.text || '通知', mapNotificationKind(evt.priority));
        break;

      case 'run.compact_boundary': {
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
        // reset 预警 flag，下一段再次接近阈值时可以重新提示
        compactWarnedRef.current = false;
        break;
      }

      case 'run.api_retry': {
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

      // 运维 / 调试信号——不展示 UI，只 console 留痕（dev 模式）。
      // 这些事件用于排查问题，不该 spam 用户视图。
      case 'run.subagent.start':
      case 'run.subagent.stop':
      case 'run.session_state':
      case 'run.session_start':
      case 'run.files_persisted':
      case 'run.memory_recall':
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

  const status = project.status === 'generating'
    ? { dot: 'running', text: '运行中' }
    : project.status === 'error'
      ? { dot: 'failed', text: '上次失败' }
      : { dot: 'idle', text: '就绪' };

  // ── handlers ──

  /**
   * ChatComposer send → POST /turn（流 A/C/B）
   * 把托盘里的 attachments（已上传成功的 asset）一起带；上传中 / 失败的不发。
   * send 成功后清空托盘。
   */
  const handleSend = async (text) => {
    if (!text || !text.trim()) return;
    const attachments = inputs
      .filter(it => it.type === 'asset' && it.path)
      .map(it => ({ type: 'asset', path: it.path, name: it.name, size: it.size }));

    setMessages(ms => [...ms, { id: newId('msg'), role: 'user', content: text }]);
    try {
      const { runId } = await Turn.send({
        pid: id,
        chat: text,
        attachments,
        // S4：显式传选中的 sessionId；null 时后端识别为"新建 session"
        sessionId: currentSessionId,
      });
      setCurrentRunId(runId);  // 终止生成用
      setActiveRun({ pid: id, runId });  // A4.3：让 AskUserQuestionView 直 POST /answer
      setInputs([]);  // 已发送的托盘清空
    } catch (err) {
      setMessages(ms => [...ms, {
        id: newId('msg'),
        role: 'assistant',
        content: `_⚠️ 发送失败：${err.message}_`,
      }]);
      showToast(`发送失败：${err.message}`, 'error');
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
    setInputs(arr => [...arr, {
      id: tempId,
      type: 'asset',
      name: input.name,
      size: input.size,
      mime: input.type,
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
  const handleRemoveInput = (assetId) => setInputs(arr => arr.filter(a => a.id !== assetId));

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
      const html = '<!doctype html>\n' + iframeDoc.documentElement.outerHTML;
      if (!currentSessionId) {
        showToast('请先开始一个会话再编辑 canvas', 'error');
        return;
      }
      await Canvas.write(id, currentSessionId, html, 'user');
      showToast(`已保存：「${info.newText.slice(0, 20)}」`, 'success');
    } catch (err) {
      showToast(`保存失败：${err.message}`, 'error');
    }
  };

  // D 流（不在 P0）
  const handleAddComment = (ctx) => {
    const text = window.prompt('为这个元素写评论（之后 AI 会按这条评论改它）：');
    if (!text || !text.trim()) return;
    setComments(arr => [...arr, {
      id: newId('cmt'),
      anchor: ctx.anchor,
      aiContext: ctx.aiContext,
      text: text.trim(),
      status: 'open',
      createdAt: new Date().toISOString(),
    }]);
    showToast('评论已添加（P0 中：D 流真接留 P0+）', 'info');
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
    const pagePart = pageInfo?.index != null ? `第 ${pageInfo.index + 1} 页` : '';
    const draft = `针对 ${pagePart}的 <${tag}>：\n\n…`;
    setChatDraft(draft);
    showToast('已填回对话框，编辑后发送', 'info');
  };

  // ── 顶栏 actions（async store ops）──
  const handleRename = async () => {
    setActionsOpen(false);
    const next = window.prompt('重命名为：', project.name);
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
    if (!window.confirm(`删除「${project.name}」？此操作不可撤销。`)) return;
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
    console.log('[spec mock]', deckSpec);
    showToast('spec mock 已 console.log（真 spec.json 在 workspace）', 'info');
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

  /**
   * 流 I 导出（用户主动按钮）：调 GET /api/projects/:pid/exports/:format
   * → blob → a.click() 触发浏览器下载
   * filename 从 content-disposition 解析；解析失败退化为 <project-name>.<ext>
   */
  const handleExport = async (format) => {
    try {
      if (!currentSessionId) {
        showToast('请先选中一个会话再导出', 'error');
        return;
      }
      const { blob, filename } = await Exports.download(id, currentSessionId, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename
        || `${project.name || 'design'}.${format === 'handoff' ? 'zip' : format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast(`已下载：${a.download}`, 'success');
    } catch (err) {
      showToast(`导出失败：${err.message}`, 'error');
    }
  };

  return (
    <PanelManagerProvider projectId={id} defaultPanels={defaultPanels} panelMeta={panelMeta}>
    <AppShell
      breadcrumb={[
        { label: '项目', to: '/' },
        { label: project.name, to: `/projects/${id}` },
        { label: currentSessionTitle || '新会话' },
      ]}
      status={status}
      actions={
        <>
          <PanelMenu />
          {(systemInfo || contextUsage) && (
            <ContextUsageBar info={systemInfo} liveUsage={contextUsage} />
          )}
          <UndoButton
            projectId={id}
            sessionId={currentSessionId}
            onUndone={() => {
              setReloadToken(t => t + 1);
              showToast('已撤销到上一版', 'success');
            }}
            onError={(err) => {
              if (err.code === 'NO_PREV_COMMIT') {
                showToast('已经是最早版本，没法再撤销', 'info');
              } else {
                showToast(`撤销失败：${err.message}`, 'error');
              }
            }}
          />
          <button style={iconBtnStyle} onClick={() => setShareOpen(true)}>
            <Share2 size={13} /> 分享
          </button>
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
              onExport={handleExport}
              onOpenList={() => setExportsListOpen(true)}
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
              onRename={handleRename}
              onDuplicate={handleDuplicate}
              onDelete={handleDelete}
              onSaveSnapshot={handleSaveSnapshotQuick}
              onOpenSnapshots={handleOpenSnapshots}
              snapshotCount={(project.snapshots || []).length}
              onViewCode={handleViewCode}
            />
          </div>
        </>
      }
    >
      {/* 主区两栏：左 ChatPanel 固定 + 右 Canvas section（占满 + 浮窗叠加） */}
      {/* AppShell children 包装层是普通 div（非 flex），用 height:100% 拿满 */}
      <div style={{
        height: '100%', display: 'flex', minHeight: 0,
        background: STAGE.bg,
        overflow: 'hidden',
      }}>
        {/* 左栏 chat 固定 */}
        <aside style={{
          width: 360, flexShrink: 0,
          display: 'flex', flexDirection: 'column',
          background: '#fff',
          borderRight: `1px solid ${COLOR.border}`,
          minHeight: 0,
        }}>
          <ChatPanel
            messages={messages}
            onSend={handleSend}
            isStreaming={isStreaming}
            trayItems={inputs}
            onRemoveTrayItem={handleRemoveInput}
            onPickFile={handleAddInput}
            promptSuggestion={promptSuggestion}
            onDismissSuggestion={() => setPromptSuggestion(null)}
            agentProgress={agentProgress}
            onStop={currentRunId ? handleStop : null}
            todos={todos}
            sessionTitle={currentSessionTitle}
            onOpenSessionList={() => setSessionListOpen(true)}
          />
        </aside>

        {/* 右主区：CanvasFrame 占满（边到边，无 padding 卡片）+ 5 浮窗叠加 */}
        {/* bounds='parent' 限制浮窗在此 section 内，不跑屏外、不跑到 chat 上 */}
        <section style={{
          flex: 1, minWidth: 0,
          position: 'relative',
          display: 'flex', flexDirection: 'column',
          background: '#fff',
        }}>
          <CanvasFrame
            htmlSrc={currentSessionId ? Canvas.artifactUrl(id, currentSessionId, reloadToken) : null}
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
            decisionsReloadKey={decisionsReloadKey}
            comments={comments}
            onAddComment={handleAddComment}
            onResolveComment={handleResolveComment}
            onDeleteComment={handleDeleteComment}
            onDirectEdit={handleDirectEdit}
            onTriggerRun={handleTriggerRun}
          />

          {/* 浮窗层 —— bounds='parent' = 不出 canvas section
              C3：inspect / comments 删 — 改用 InspectFloatingCard（CanvasFrame 内贴选中元素） */}
          <FloatingPanel id="tweaks" title="Tweaks" icon={Sliders}>
            <div style={{ padding: GAP.lg }}>
              <div style={{
                fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500,
                color: COLOR.text, marginBottom: GAP.sm,
              }}>Tweaks</div>
              <p style={{
                fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
                lineHeight: 1.6, margin: 0,
              }}>
                agent 暴露的可调参数（color / spacing / layout variant）。C5 接
                expose_tweaks MCP 工具 → 按 schema 渲染 sliders。
              </p>
            </div>
          </FloatingPanel>
        </section>
      </div>

      <ShareModal show={shareOpen} onClose={() => setShareOpen(false)} project={project} />
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
          // H1：切换 session 走 URL navigate（URL 是 sid 唯一 source of
          // truth），useEffect 会自动重 hydrate messages。
          // sid=null → 新会话路径 /work；有 sid → /sessions/<sid>
          navigate(sid ? `/projects/${id}/sessions/${sid}` : `/projects/${id}/work`);
        }}
      />

    </AppShell>
    </PanelManagerProvider>
  );
}

// ── helpers ──

/**
 * 同 role 连续 text delta 累加为一条消息；否则 push 新消息。
 * thinking 自带 isStreaming=true（用于尾部光标）；非 thinking 内容产生时
 * 自动关掉之前所有 thinking 的 isStreaming 标记（那段思考已经结束了）。
 */
function appendTextDelta(messages, role, text) {
  if (!text) return messages;
  const cleared = role === 'thinking' ? messages : clearThinkingStreaming(messages);
  const last = cleared[cleared.length - 1];
  if (last && last.role === role) {
    const merged = { ...last, content: (last.content || '') + text };
    if (role === 'thinking') merged.isStreaming = true;
    return [...cleared.slice(0, -1), merged];
  }
  const created = { id: newId('msg'), role, content: text };
  if (role === 'thinking') created.isStreaming = true;
  return [...cleared, created];
}

/** 关掉所有 thinking 消息的流式光标（run 结束 / 切到非 thinking 内容时调）*/
function clearThinkingStreaming(messages) {
  let changed = false;
  const next = messages.map(m => {
    if (m.role === 'thinking' && m.isStreaming) {
      changed = true;
      return { ...m, isStreaming: false };
    }
    return m;
  });
  return changed ? next : messages;
}

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
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.h1, fontWeight: 600,
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
          borderRadius: 8,
        }}>返回首页</Link>
      </div>
    </AppShell>
  );
}

const iconBtnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  padding: `${GAP.xs + 1}px ${GAP.lg}px`,
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2,
  background: 'rgba(0,0,0,0.04)',
  borderRadius: 6,
  border: 'none',
  cursor: 'pointer',
};

const primaryBtnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  padding: `${GAP.xs + 1}px ${GAP.lg}px`,
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 500,
  color: COLOR.btnText, background: COLOR.btn,
  border: `1px solid ${COLOR.btn}`,
  borderRadius: 6,
  cursor: 'pointer',
};
