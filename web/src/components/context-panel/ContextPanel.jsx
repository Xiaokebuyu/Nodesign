import { useState, useEffect } from 'react';
import { Crosshair, MessageCircle, Sliders, Settings, Bookmark } from 'lucide-react';
import SystemTab from './SystemTab.jsx';
import InspectTab from './InspectTab.jsx';
import CommentsTab from './CommentsTab.jsx';
import DecisionsTab from './DecisionsTab.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';

/**
 * Context Panel — 工作台右栏 tab（H4a 清理后聚焦"运行时上下文"）
 *
 * Tab 顺序：Inspect · Comments · Decisions · Tweaks · System
 *
 * H4a 改动：
 * - 删 "项目背景"（搬到 Hub Instructions card 编辑 .claude/CLAUDE.md）
 * - 删 Inputs（搬到 Hub Files card 管理 shared/assets）
 * - 默认 tab 改 inspect（工作时常用）
 * - 顺手解决 7 tab 中文挤压成竖排的 cosmetic 问题
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
  const [tab, setTab] = useState('inspect');

  // 选中元素时自动切到 Inspect tab
  useEffect(() => {
    if (selectedAnchor) setTab('inspect');
  }, [selectedAnchor]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* TabBar */}
      <div style={{
        display: 'flex',
        borderBottom: `1px solid ${COLOR.border}`,
        padding: `0 ${GAP.md}px`,
      }}>
        {TABS.map(t => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                flex: 1,
                padding: `${GAP.md + 2}px ${GAP.xs}px`,
                fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, fontWeight: 500,
                color: active ? COLOR.text : COLOR.sub,
                borderBottom: active ? `2px solid ${COLOR.btn}` : '2px solid transparent',
                marginBottom: -1,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                gap: GAP.xs,
                transition: 'color 0.2s',
              }}
            >
              <Icon size={11} /> {t.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {tab === 'inspect'  && (
          <InspectTab
            selectedAnchor={selectedAnchor}
            iframeDoc={iframeDoc}
            onAddComment={onAddComment}
            onDirectEdit={onDirectEdit}
            onTriggerRun={onTriggerRun}
          />
        )}
        {tab === 'comments' && (
          <CommentsTab
            comments={comments}
            onJump={onJumpToComment}
            onResolve={onResolveComment}
            onDelete={onDeleteComment}
          />
        )}
        {tab === 'decisions' && (
          <DecisionsTab projectId={project?.id} sessionId={sessionId} reloadKey={decisionsReloadKey} />
        )}
        {tab === 'tweaks'   && <PlaceholderTab title="Tweaks" desc="agent 暴露的可调参数（color / spacing / layout variant）。P0+ stage 2 接 tweak-proposer subagent → schemas/tweak-schema.json 渲染 sliders。" />}
        {tab === 'system'   && <SystemTab project={project} deckSpec={deckSpec} />}
      </div>
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
