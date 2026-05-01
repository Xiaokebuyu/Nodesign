import { useState, useEffect } from 'react';
import { Upload, Crosshair, MessageCircle, Sliders, Settings, Bookmark, BookOpen } from 'lucide-react';
import InputsTab from './InputsTab.jsx';
import SystemTab from './SystemTab.jsx';
import InspectTab from './InspectTab.jsx';
import CommentsTab from './CommentsTab.jsx';
import DecisionsTab from './DecisionsTab.jsx';
import BackgroundTab from './BackgroundTab.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';

/**
 * Context Panel — 右栏 5 tab（含 Design Principle §8 的 Inspect tab）
 *
 * Tab 顺序：Inputs · Inspect · Comments · Tweaks · System
 *
 * 受控 tab：Project 持有 selectedAnchor，selectedAnchor 变时切到 Inspect。
 *
 * P2：Inputs / Inspect / System 实现，Comments / Tweaks 占位（Comments 等 P5 接 LLM）
 */
const TABS = [
  { id: 'background', label: '项目背景', icon: BookOpen },
  { id: 'inputs',     label: 'Inputs',    icon: Upload },
  { id: 'inspect',    label: 'Inspect',   icon: Crosshair },
  { id: 'comments',   label: 'Comments',  icon: MessageCircle },
  { id: 'decisions',  label: 'Decisions', icon: Bookmark },
  { id: 'tweaks',     label: 'Tweaks',    icon: Sliders },
  { id: 'system',     label: 'System',    icon: Settings },
];

export default function ContextPanel({
  project, deckSpec, comments = [], inputs = [], onAddInput, onRemoveInput,
  selectedAnchor, iframeDoc,
  onAddComment, onDirectEdit, onTriggerRun,
  onJumpToComment, onResolveComment, onDeleteComment,
  decisionsReloadKey = 0,
}) {
  const [tab, setTab] = useState('background');

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
        {tab === 'background' && <BackgroundTab projectId={project?.id} />}
        {tab === 'inputs'   && <InputsTab inputs={inputs} onAdd={onAddInput} onRemove={onRemoveInput} />}
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
          <DecisionsTab projectId={project?.id} reloadKey={decisionsReloadKey} />
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
