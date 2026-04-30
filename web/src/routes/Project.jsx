import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { Share2, Download, MoreHorizontal } from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
import ThreeColumnLayout from '../components/layout/ThreeColumnLayout.jsx';
import ChatPanel from '../components/chat/ChatPanel.jsx';
import CanvasFrame from '../components/canvas/CanvasFrame.jsx';
import ContextPanel from '../components/context-panel/ContextPanel.jsx';
import ShareModal from '../components/project/ShareModal.jsx';
import ExportMenu from '../components/project/ExportMenu.jsx';
import ProjectActionsMenu from '../components/project/ProjectActionsMenu.jsx';
import SnapshotModal from '../components/project/SnapshotModal.jsx';
import DirectEditModal from '../components/canvas/DirectEditModal.jsx';
import UndoButton from '../components/canvas/UndoButton.jsx';
import ContextUsageBar from '../components/project/ContextUsageBar.jsx';
import ExportsListModal from '../components/project/ExportsListModal.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO } from '../lib/theme.js';
import { useProjectStore } from '../stores/projectStore.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { MOCK_DECK_SPEC } from '../mock/deck-spec.js';
import { newId } from '../lib/helpers.js';
import { findElementByAnchor } from '../lib/html-utils.js';
import { Canvas, Turn, Assets, Exports } from '../lib/api.js';
import { openProjectWS } from '../lib/ws-client.js';

export default function Project() {
  const { id } = useParams();
  const navigate = useNavigate();

  // ── store ──
  const project = useProjectStore(s => s.projects.find(p => p.id === id));
  const hydrateOne = useProjectStore(s => s.hydrateOne);
  const updateProject = useProjectStore(s => s.updateProject);
  const deleteProject = useProjectStore(s => s.deleteProject);
  const duplicateProject = useProjectStore(s => s.duplicateProject);
  const applyRunEvent = useProjectStore(s => s.applyRunEvent);
  const showToast = useGlobalStore(s => s.showToast);
  const setChatDraft = useGlobalStore(s => s.setChatDraft);

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
  const [promptSuggestion, setPromptSuggestion] = useState(null);
  const [agentProgress, setAgentProgress] = useState(null);
  // C29：DecisionsTab 自动刷新触发器（agent 调 record_decision / compact 后 bump）
  const [decisionsReloadKey, setDecisionsReloadKey] = useState(0);

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

  // ── memo / callback（必须在 early return 之前）──
  const deckSpec = useMemo(() => MOCK_DECK_SPEC, []);

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

  /** WS 事件 → chat messages / iframe reload 翻译层 */
  function handleEvent(evt) {
    switch (evt.type) {
      case 'run.start':
        setIsStreaming(true);
        break;
      case 'run.delta.text':
        setMessages(prev => appendTextDelta(prev, 'assistant', evt.text));
        break;
      case 'run.delta.thinking':
        setMessages(prev => appendTextDelta(prev, 'thinking', evt.text));
        break;
      case 'run.delta.tool_use':
        setMessages(prev => [...prev, {
          id: evt.blockId || newId('tool'),
          role: 'tool',
          toolName: evt.name,
          toolInput: evt.input,
          status: 'running',
        }]);
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
        // 双保险：FileChanged hook（run.file_changed）应该已 bump 过 reloadToken
        // 但万一 hook 不触发（如 SDK 边角问题），这里兜底再 bump 一次
        setReloadToken(t => t + 1);
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
        setMessages(prev => [...prev, {
          id: newId('msg'),
          role: 'assistant',
          content: `_⚠️ ${evt.message || '运行出错'}_`,
        }]);
        showToast(`运行失败：${evt.message || '未知错误'}`, 'error');
        break;
      case 'run.cancelled':
        setIsStreaming(false);
        setPromptSuggestion(null);
        setAgentProgress(null);
        showToast('已取消', 'info');
        break;

      // ── P0+ s1 C17：新事件类型 ──

      case 'run.system_init':
        // SDK 启动元信息：model / tools / mcp_servers / agents
        setSystemInfo(evt.info);
        break;

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

      // ws.connected / run.sdk.session / run.compact_boundary / run.todo.updated /
      // run.hook.* / run.notification / run.task.started / run.task.updated /
      // run.memory_recall / run.session_state 等暂不展示在 chat，console 即可
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
      await Turn.send({ pid: id, chat: text, attachments });
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
      await Canvas.write(id, html, 'user');
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
      const { blob, filename } = await Exports.download(id, format);
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
    <AppShell
      breadcrumb={[{ label: '项目', to: '/' }, { label: project.name }]}
      status={status}
      actions={
        <>
          {systemInfo && <ContextUsageBar info={systemInfo} />}
          <UndoButton
            projectId={id}
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
      <ThreeColumnLayout
        left={
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
          />
        }
        center={
          <CanvasFrame
            htmlSrc={Canvas.artifactUrl(id, reloadToken)}
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
          />
        }
        right={
          <ContextPanel
            project={project}
            deckSpec={deckSpec}
            inputs={inputs}
            comments={comments}
            onAddInput={handleAddInput}
            onRemoveInput={handleRemoveInput}
            selectedAnchor={selectedAnchor}
            iframeDoc={iframeDoc}
            onAddComment={handleAddComment}
            onDirectEdit={handleDirectEdit}
            onTriggerRun={handleTriggerRun}
            onJumpToComment={handleJumpToComment}
            onResolveComment={handleResolveComment}
            onDeleteComment={handleDeleteComment}
            decisionsReloadKey={decisionsReloadKey}
          />
        }
      />

      <ShareModal show={shareOpen} onClose={() => setShareOpen(false)} project={project} />
      <ExportsListModal
        show={exportsListOpen}
        onClose={() => setExportsListOpen(false)}
        projectId={id}
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
    </AppShell>
  );
}

// ── helpers ──

/** 同 role 连续 text delta 累加为一条消息；否则 push 新消息 */
function appendTextDelta(messages, role, text) {
  if (!text) return messages;
  const last = messages[messages.length - 1];
  if (last && last.role === role) {
    return [...messages.slice(0, -1), { ...last, content: (last.content || '') + text }];
  }
  return [...messages, { id: newId('msg'), role, content: text }];
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
