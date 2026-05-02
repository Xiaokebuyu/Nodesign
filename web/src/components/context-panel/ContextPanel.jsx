import { useState, useEffect } from 'react';
import { Crosshair, MessageCircle, Sliders, Settings, Bookmark } from 'lucide-react';
import SystemTab from './SystemTab.jsx';
import InspectTab from './InspectTab.jsx';
import CommentsTab from './CommentsTab.jsx';
import DecisionsTab from './DecisionsTab.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';

/**
 * Context Panel — 工作台右栏 tab（S2 commit 2 改 multi-collapse 模式）
 *
 * Tab 顺序：Inspect · Comments · Decisions · Tweaks · System
 *
 * Canvas 焕新升级 S2（2026-05-02）：从 single-active tab 改为 multi-collapse。
 *   理由：用户客户化（不主动调右栏，agent 在画布 emit tweak），右栏功能默认收起，
 *   要看的时候点 tab button toggle 展开。多个 tab 可同时展开（垂直堆叠）。
 *   Direct Edits / InspectTab 保留作高级后路，不聚焦。
 *
 * 默认行为：
 *   - 初值：['inspect']（H4a 已确定 inspect 是工作常用，保留默认展开）
 *   - selectedAnchor 变化 → 自动 add 'inspect' 到 expanded（不主动收别的）
 *   - tab button click → toggle in/out array
 *   - 多个 tab 同时展开 → 垂直堆叠（每个 tab 内容是独立 section）
 *
 * H4a 历史：删 "项目背景"（→ Hub Instructions card）+ 删 Inputs（→ Hub Files card）+
 *           顺手解决 7 tab 中文挤压成竖排的 cosmetic 问题
 */
const TABS = [
  { id: 'inspect',    label: 'Inspect',   icon: Crosshair },
  { id: 'comments',   label: 'Comments',  icon: MessageCircle },
  { id: 'decisions',  label: 'Decisions', icon: Bookmark },
  { id: 'tweaks',     label: 'Tweaks',    icon: Sliders },
  { id: 'system',     label: 'System',    icon: Settings },
];

export default function ContextPanel({
  project, deckSpec, comments = [],
  selectedAnchor, iframeDoc,
  onAddComment, onDirectEdit, onTriggerRun,
  onJumpToComment, onResolveComment, onDeleteComment,
  decisionsReloadKey = 0,
  sessionId,
}) {
  // S2：multi-collapse —— array 而非单值
  const [expandedTabs, setExpandedTabs] = useState(['inspect']);

  // 选中元素时自动展开 Inspect tab（如果之前 collapse；不主动 collapse 别的）
  useEffect(() => {
    if (selectedAnchor) {
      setExpandedTabs(prev => prev.includes('inspect') ? prev : [...prev, 'inspect']);
    }
  }, [selectedAnchor]);

  const toggleTab = (id) => {
    setExpandedTabs(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* TabBar —— 每个 button 独立 toggle in/out expandedTabs */}
      <div style={{
        display: 'flex',
        borderBottom: `1px solid ${COLOR.border}`,
        padding: `0 ${GAP.md}px`,
      }}>
        {TABS.map(t => {
          const Icon = t.icon;
          const expanded = expandedTabs.includes(t.id);
          return (
            <button
              key={t.id}
              onClick={() => toggleTab(t.id)}
              style={{
                flex: 1,
                padding: `${GAP.md + 2}px ${GAP.xs}px`,
                fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, fontWeight: 500,
                color: expanded ? COLOR.text : COLOR.sub,
                background: expanded ? 'rgba(0,0,0,0.04)' : 'transparent',
                borderBottom: expanded ? `2px solid ${COLOR.btn}` : '2px solid transparent',
                marginBottom: -1,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                gap: GAP.xs,
                transition: 'color 0.2s, background 0.2s',
              }}
              title={`${expanded ? '收起' : '展开'} ${t.label}`}
            >
              <Icon size={11} /> {t.label}
            </button>
          );
        })}
      </div>

      {/* Tab content —— 多个展开的 tab 垂直堆叠，每个独立 section */}
      <div style={{
        flex: 1, minHeight: 0, overflow: 'auto',
        display: 'flex', flexDirection: 'column', gap: GAP.md,
      }}>
        {expandedTabs.includes('inspect') && (
          <TabSection title="Inspect">
            <InspectTab
              selectedAnchor={selectedAnchor}
              iframeDoc={iframeDoc}
              onAddComment={onAddComment}
              onDirectEdit={onDirectEdit}
              onTriggerRun={onTriggerRun}
            />
          </TabSection>
        )}
        {expandedTabs.includes('comments') && (
          <TabSection title="Comments">
            <CommentsTab
              comments={comments}
              onJump={onJumpToComment}
              onResolve={onResolveComment}
              onDelete={onDeleteComment}
            />
          </TabSection>
        )}
        {expandedTabs.includes('decisions') && (
          <TabSection title="Decisions">
            <DecisionsTab projectId={project?.id} sessionId={sessionId} reloadKey={decisionsReloadKey} />
          </TabSection>
        )}
        {expandedTabs.includes('tweaks') && (
          <TabSection title="Tweaks">
            <PlaceholderTab title="Tweaks" desc="agent 暴露的可调参数（color / spacing / layout variant）。S3 接 expose_tweaks MCP 工具 → schemas/tweak-schema.json 渲染 sliders。" />
          </TabSection>
        )}
        {expandedTabs.includes('system') && (
          <TabSection title="System">
            <SystemTab project={project} deckSpec={deckSpec} />
          </TabSection>
        )}
        {expandedTabs.length === 0 && (
          <div style={{
            padding: GAP.xl,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
            textAlign: 'center', lineHeight: 1.6,
          }}>
            点上方 tab 按钮展开对应面板。
            <br />
            或在画布上点元素，自动展开 Inspect。
          </div>
        )}
      </div>
    </div>
  );
}

// 多 tab 同时展开时用 section 包，提供视觉分隔（subtle border-bottom）。
// 单 tab 展开时也用，保持视觉一致。
function TabSection({ title: _title, children }) {
  return (
    <div style={{
      borderBottom: `1px solid ${COLOR.borderLt}`,
      paddingBottom: GAP.sm,
    }}>
      {children}
    </div>
  );
}

function PlaceholderTab({ title, desc, count }) {
  return (
    <div style={{ padding: GAP.lg }}>
      <div style={{
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500,
        color: COLOR.text, marginBottom: GAP.sm,
      }}>{title} {count !== undefined && <span style={{ color: COLOR.sub, fontWeight: 400 }}>({count})</span>}</div>
      <p style={{
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
        lineHeight: 1.6, margin: 0,
      }}>{desc}</p>
    </div>
  );
}
