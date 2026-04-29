import { useState, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Share2, Download, MoreHorizontal } from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
import ThreeColumnLayout from '../components/layout/ThreeColumnLayout.jsx';
import ChatPanel from '../components/chat/ChatPanel.jsx';
import CanvasFrame from '../components/canvas/CanvasFrame.jsx';
import ContextPanel from '../components/context-panel/ContextPanel.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO } from '../lib/theme.js';
import { findMockProject } from '../mock/projects.js';
import { MOCK_DECK_SPEC } from '../mock/deck-spec.js';
import { newId } from '../lib/helpers.js';

const INITIAL_MESSAGES = [
  { id: 'm1', role: 'user',      content: '做一个介绍 Nodesign 的内部 deck，5 页左右。受众是团队同事，重点说明"工作台"和"反向优化 skill"两个概念。不要 emoji。' },
  { id: 'm2', role: 'thinking',  content: '用户要的是内部技术沟通向 deck，metaphor 应该走"基础设施"路线（不是"魔法 AI"路线）。\n5 页结构推荐：\n1. cover — 立"工作台"心智\n2. 当前问题 — 手工艺式生成\n3. 对比 — 传统 vs Nodesign 范式\n4. 数据 — 迭代速度变化\n5. 收尾 — 反向优化 skill 的承诺\n\npalette 用亮黑 + 深棕 + 暖白系，对齐组织视觉语言。' },
  { id: 'm3', role: 'tool',      toolName: 'write_file', toolInput: { path: '00-peer-candidates.md' }, status: 'success', toolOutput: '✓ 写入 metaphor 候选三元组（3 个）' },
  { id: 'm4', role: 'tool',      toolName: 'write_file', toolInput: { path: '01-design-intent.md' }, status: 'success', toolOutput: '✓ 写入设计意图' },
  { id: 'm5', role: 'tool',      toolName: 'write_file', toolInput: { path: 'deck.html' }, status: 'success', toolOutput: '✓ 写入 5 页 self-contained HTML' },
  { id: 'm6', role: 'assistant', content: '已生成 5 页 deck，metaphor 是**"从画板到工厂的演化"**。\n\n关键决策：\n- 不用 emoji 也不用插画，纯文字 + 几何对比\n- 第 3 页用 two-column 强对比，第 4 页用极简柱状图\n- 整体走亮黑 #2d2418 + 深棕 #3a2a18，跟 dev/ 风格一致\n\n双击 canvas 上的文字可以直接改。如果整体方向要换，跟我说就行。' },
];

export default function Project() {
  const { id } = useParams();
  const project = findMockProject(id);
  const [messages, setMessages] = useState(INITIAL_MESSAGES);
  const [inputs, setInputs] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);

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
    // P1：模拟 agent 反馈（不接后端）
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

  const handleAddInput = (asset) => {
    setInputs(arr => [...arr, asset]);
  };
  const handleRemoveInput = (assetId) => {
    setInputs(arr => arr.filter(a => a.id !== assetId));
  };

  const handleTextEdit = (info) => {
    // P1 只 console.log；P2 落本地 patch state；P3 PATCH 后端
    console.log('[Project] text edit', info);
  };

  return (
    <AppShell
      breadcrumb={[{ label: '项目', to: '/' }, { label: project.name }]}
      status={status}
      actions={
        <>
          <button style={iconBtnStyle} title="分享（P2）"><Share2 size={13} /> 分享</button>
          <button style={primaryBtnStyle} title="导出（P7）"><Download size={13} /> 导出</button>
          <button style={iconBtnStyle} title="更多"><MoreHorizontal size={14} /></button>
        </>
      }
    >
      <ThreeColumnLayout
        left={<ChatPanel messages={messages} onSend={handleSend} isStreaming={isStreaming} />}
        center={<CanvasFrame htmlSrc="/mock/deck.html" onTextEdit={handleTextEdit} />}
        right={
          <ContextPanel
            project={project}
            deckSpec={deckSpec}
            inputs={inputs}
            onAddInput={handleAddInput}
            onRemoveInput={handleRemoveInput}
          />
        }
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
};

const primaryBtnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  padding: `${GAP.xs + 1}px ${GAP.lg}px`,
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 500,
  color: COLOR.btnText, background: COLOR.btn,
  border: `1px solid ${COLOR.btn}`,
  borderRadius: 6,
};
