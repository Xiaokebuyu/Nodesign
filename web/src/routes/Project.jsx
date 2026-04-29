import { useState, useMemo, useCallback, useRef } from 'react';
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
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO } from '../lib/theme.js';
import { useProjectStore } from '../stores/projectStore.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { MOCK_DECK_SPEC } from '../mock/deck-spec.js';
import { newId } from '../lib/helpers.js';
import { findElementByAnchor } from '../lib/html-utils.js';

const INITIAL_MESSAGES = [
  { id: 'm1', role: 'user',      content: '做一个介绍 Nodesign 的内部 deck，5 页左右。受众是团队同事，重点说明"工作台"和"反向优化 skill"两个概念。不要 emoji。' },
  { id: 'm2', role: 'thinking',  content: '用户要的是内部技术沟通向 deck，metaphor 应该走"基础设施"路线（不是"魔法 AI"路线）。\n5 页结构推荐：\n1. cover — 立"工作台"心智\n2. 当前问题 — 手工艺式生成\n3. 对比 — 传统 vs Nodesign 范式\n4. 数据 — 迭代速度变化\n5. 收尾 — 反向优化 skill 的承诺' },
  { id: 'm3', role: 'tool',      toolName: 'write_file', toolInput: { path: '00-peer-candidates.md' }, status: 'success', toolOutput: '✓ 写入 metaphor 候选三元组（3 个）' },
  { id: 'm4', role: 'tool',      toolName: 'write_file', toolInput: { path: '01-design-intent.md' }, status: 'success', toolOutput: '✓ 写入设计意图' },
  { id: 'm5', role: 'tool',      toolName: 'write_file', toolInput: { path: 'deck.html' }, status: 'success', toolOutput: '✓ 写入 5 页 self-contained HTML' },
  { id: 'm6', role: 'assistant', content: '已生成 5 页 deck，metaphor 是**"从画板到工厂的演化"**。\n\n关键决策：\n- 不用 emoji 也不用插画，纯文字 + 几何对比\n- 第 3 页用 two-column 强对比，第 4 页用极简柱状图\n- 整体走亮黑 #2d2418 + 深棕 #3a2a18，跟 dev/ 风格一致\n\n双击 canvas 上的文字可以直接改。如果整体方向要换，跟我说就行。' },
];

export default function Project() {
  const { id } = useParams();
  const navigate = useNavigate();
  const project = useProjectStore(s => s.projects.find(p => p.id === id));
  const updateProject = useProjectStore(s => s.updateProject);
  const deleteProject = useProjectStore(s => s.deleteProject);
  const duplicateProject = useProjectStore(s => s.duplicateProject);
  const saveSnapshot = useProjectStore(s => s.saveSnapshot);
  const deleteSnapshotStore = useProjectStore(s => s.deleteSnapshot);
  const renameSnapshot = useProjectStore(s => s.renameSnapshot);
  const addCandidate = useProjectStore(s => s.addCandidate);
  const removeCandidate = useProjectStore(s => s.removeCandidate);
  const renameCandidate = useProjectStore(s => s.renameCandidate);
  const selectCandidate = useProjectStore(s => s.selectCandidate);
  const showToast = useGlobalStore(s => s.showToast);

  const [messages, setMessages] = useState(INITIAL_MESSAGES);
  const [inputs, setInputs] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [selectedAnchor, setSelectedAnchor] = useState(null);
  const [iframeDoc, setIframeDoc] = useState(null);

  const [shareOpen, setShareOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [directEditOpen, setDirectEditOpen] = useState(false);
  const [directEditAnchor, setDirectEditAnchor] = useState(null);
  const [patches, setPatches] = useState([]);  // [{ id, type, anchor, oldValue, newValue, ts }]
  const [comments, setComments] = useState([]);  // [{ id, anchor, aiContext, text, status, createdAt }]
  const exportBtnRef = useRef(null);
  const actionsBtnRef = useRef(null);
  const setChatDraft = useGlobalStore(s => s.setChatDraft);

  const handleIframeReady = useCallback((iframe) => {
    try { setIframeDoc(iframe.contentDocument); } catch { /* cross-origin */ }
  }, []);

  const deckSpec = useMemo(() => MOCK_DECK_SPEC, []);

  if (!project) {
    return <NotFound id={id} />;
  }

  const status = project.status === 'running'
    ? { dot: 'running', text: '运行中' }
    : project.status === 'failed'
      ? { dot: 'failed', text: '上次失败' }
      : { dot: 'idle', text: '就绪' };

  const handleSend = (text) => {
    setMessages(ms => [...ms, { id: newId('msg'), role: 'user', content: text }]);
    setIsStreaming(true);
    setTimeout(() => {
      setMessages(ms => [...ms, {
        id: newId('msg'),
        role: 'assistant',
        content: '_(P1 mock：后端没接，没真生成。这条只是回执。P3 后端起来后这里会接真实 SSE/WS 流。)_',
      }]);
      setIsStreaming(false);
    }, 800);
  };

  const handleAddInput = (asset) => setInputs(arr => [...arr, asset]);
  const handleRemoveInput = (assetId) => setInputs(arr => arr.filter(a => a.id !== assetId));

  const handleTextEdit = (info) => {
    setPatches(arr => [...arr, {
      id: newId('patch'),
      type: 'text-edit',
      anchor: info.anchor,
      oldValue: info.oldText,
      newValue: info.newText,
      ts: new Date().toISOString(),
    }]);
    showToast(`已修改文字：「${info.newText.slice(0, 20)}」`, 'success');
  };

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
    showToast('评论已添加', 'success');
  };
  const handleJumpToComment = (comment) => {
    if (!iframeDoc) return;
    const el = findElementByAnchor(comment.anchor, iframeDoc.body);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setSelectedAnchor(comment.anchor);
    } else {
      showToast('元素已不存在（可能已被改动）', 'error');
    }
  };
  const handleResolveComment = (id) => {
    setComments(arr => arr.map(c =>
      c.id === id ? { ...c, status: c.status === 'resolved' ? 'open' : 'resolved' } : c
    ));
  };
  const handleDeleteComment = (id) => {
    setComments(arr => arr.filter(c => c.id !== id));
    showToast('评论已删除', 'info');
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
    const keys = Object.keys(changes).join(' / ');
    showToast(`已应用：${keys}`, 'success');
  };
  const handleTriggerRun = (ctx) => {
    const ai = ctx.aiContext;
    const tag = ai?.tag || 'element';
    const pageInfo = ai?.pageInfo;
    const pagePart = pageInfo?.index != null ? `第 ${pageInfo.index + 1} 页` : '';
    const scopeText = {
      'this': '只改这一处',
      'sameType-page': `这页所有 ${tag}`,
      'sameType-deck': `整 deck 所有 ${tag}`,
      'spec': '改 spec 重生成',
    }[ctx.scope] || ctx.scope;
    const draft = `针对 ${pagePart}的 <${tag}>（${scopeText}）：\n\n…`;
    setChatDraft(draft);
    showToast('已填回对话框，编辑后发送', 'info');
  };

  // 顶栏 actions
  const handleRename = () => {
    setActionsOpen(false);
    const next = window.prompt('重命名为：', project.name);
    if (next && next.trim() && next !== project.name) {
      updateProject(project.id, { name: next.trim() });
      showToast(`已重命名为「${next.trim()}」`, 'success');
    }
  };
  const handleDuplicate = () => {
    setActionsOpen(false);
    const copy = duplicateProject(project.id);
    if (copy) {
      showToast(`已复制为「${copy.name}」`, 'success');
      navigate(`/projects/${copy.id}`);
    }
  };
  const handleDelete = () => {
    setActionsOpen(false);
    if (window.confirm(`删除「${project.name}」？此操作不可撤销。`)) {
      deleteProject(project.id);
      showToast('项目已删除', 'info');
      navigate('/');
    }
  };
  const handleViewCode = () => {
    setActionsOpen(false);
    console.log('[spec]', deckSpec);
    showToast('spec JSON 已 console.log', 'info');
  };

  // 快照
  const handleSaveSnapshotQuick = () => {
    setActionsOpen(false);
    const snap = saveSnapshot(project.id);
    if (snap) showToast(`快照「${snap.label}」已保存`, 'success');
  };
  const handleOpenSnapshots = () => {
    setActionsOpen(false);
    setSnapshotOpen(true);
  };
  const handleSnapshotSave = (label) => {
    const snap = saveSnapshot(project.id, label);
    if (snap) showToast(`快照「${snap.label}」已保存`, 'success');
  };
  const handleSnapshotRestore = (snapshot) => {
    showToast(`P3+：恢复到「${snapshot.label}」（mock：未真改 HTML）`, 'info');
  };
  const handleSnapshotDelete = (snapshot) => {
    deleteSnapshotStore(project.id, snapshot.id);
    showToast('快照已删除', 'info');
  };
  const handleSnapshotRename = (snapshotId, label) => {
    renameSnapshot(project.id, snapshotId, label);
  };

  // 候选
  const handleAddCandidate = () => {
    const cand = addCandidate(project.id);
    if (cand) showToast(`已添加「${cand.label}」（mock：复制当前）`, 'success');
  };
  const handleRemoveCandidate = (candidateId) => {
    removeCandidate(project.id, candidateId);
    showToast('候选已删除', 'info');
  };
  const handleRenameCandidate = (candidateId, label) => {
    renameCandidate(project.id, candidateId, label);
  };
  const handleSelectCandidate = (candidateId) => {
    selectCandidate(project.id, candidateId);
    setSelectedAnchor(null);
  };

  // 导出
  const handleExport = (format) => {
    if (format === 'html') {
      // P2 mock：fetch mock/deck.html → 触发下载
      fetch('/mock/deck.html')
        .then(r => r.text())
        .then(html => {
          const blob = new Blob([html], { type: 'text/html' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${project.name || 'deck'}.html`;
          a.click();
          URL.revokeObjectURL(url);
          showToast(`HTML 已下载：${a.download}`, 'success');
        })
        .catch(() => showToast('下载失败', 'error'));
    } else if (format === 'handoff') {
      showToast('P7 工程交付包：HTML + chat history + spec + README + prompt', 'info');
    } else {
      showToast(`${format.toUpperCase()} 导出 P7 实现`, 'info');
    }
  };

  return (
    <AppShell
      breadcrumb={[{ label: '项目', to: '/' }, { label: project.name }]}
      status={status}
      actions={
        <>
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
        left={<ChatPanel messages={messages} onSend={handleSend} isStreaming={isStreaming} />}
        center={
          <CanvasFrame
            htmlSrc="/mock/deck.html"
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
          />
        }
      />

      <ShareModal show={shareOpen} onClose={() => setShareOpen(false)} project={project} />
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

function NotFound({ id }) {
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
          可能 ID 写错了，或这个项目已被删除。
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
