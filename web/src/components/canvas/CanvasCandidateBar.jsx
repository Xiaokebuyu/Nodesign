import { useState } from 'react';
import { Plus, X, GitBranch } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO } from '../../lib/theme.js';

/**
 * CanvasCandidateBar — 候选切换条
 *
 * 一个项目可以并行 explore 多个 candidate（Claude_design §11 / §12.2 强调
 * "side-by-side alternatives 比猜测更快"）。
 *
 * P2 mock：每个 candidate 共享同一份 mock deck.html；P5 后 agent 真生成时各 candidate
 * 持有独立 htmlArtifact + spec。
 *
 * candidates: [{ id, label, htmlSrc?, summary? }]
 * activeId: 当前选中的 candidate id
 */
export default function CanvasCandidateBar({ candidates, activeId, onSelect, onAdd, onRemove, onRename }) {
  if (!candidates || candidates.length === 0) return null;

  const single = candidates.length === 1;

  return (
    <div style={{
      flexShrink: 0,
      height: 36,
      borderBottom: `1px solid ${COLOR.border}`,
      background: '#fff',
      padding: `0 ${GAP.lg}px`,
      display: 'flex',
      alignItems: 'center',
      gap: GAP.xs,
      overflowX: 'auto', overflowY: 'hidden',
    }}>
      <GitBranch size={11} color={COLOR.sub} style={{ flexShrink: 0, marginRight: GAP.xs }} />

      {candidates.map(c => {
        const active = c.id === activeId;
        return (
          <CandidateTab
            key={c.id}
            candidate={c}
            active={active}
            onSelect={() => onSelect?.(c.id)}
            onRemove={!single ? () => onRemove?.(c.id) : null}
            onRename={onRename}
          />
        );
      })}

      <button
        onClick={onAdd}
        title="新建候选（mock 复制当前）"
        style={{
          flexShrink: 0,
          padding: `${GAP.xs}px ${GAP.md}px`,
          display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
          background: 'transparent',
          border: `1px dashed ${COLOR.borderMd}`,
          borderRadius: 4,
          cursor: 'pointer',
        }}
        onMouseEnter={e => { e.currentTarget.style.color = COLOR.text2; e.currentTarget.style.background = 'rgba(0,0,0,0.03)'; }}
        onMouseLeave={e => { e.currentTarget.style.color = COLOR.sub; e.currentTarget.style.background = 'transparent'; }}
      >
        <Plus size={11} /> 新候选
      </button>

      <div style={{ flex: 1 }} />

      <span style={{
        fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub,
        opacity: single ? 0 : 0.7,
        flexShrink: 0,
      }}>
        {candidates.length} 个候选
      </span>
    </div>
  );
}

function CandidateTab({ candidate, active, onSelect, onRemove, onRename }) {
  const [hover, setHover] = useState(false);

  const handleDblClick = (e) => {
    e.stopPropagation();
    if (!onRename) return;
    const next = window.prompt('重命名候选：', candidate.label);
    if (next && next.trim() && next !== candidate.label) {
      onRename(candidate.id, next.trim());
    }
  };

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flexShrink: 0,
        position: 'relative',
        display: 'inline-flex', alignItems: 'center',
        background: active ? 'rgba(45,36,24,0.06)' : 'transparent',
        borderRadius: 4,
        transition: 'background 0.15s',
      }}
    >
      <button
        onClick={onSelect}
        onDoubleClick={handleDblClick}
        title="双击重命名"
        style={{
          padding: `${GAP.xs}px ${onRemove && hover ? GAP.lg : GAP.md}px ${GAP.xs}px ${GAP.md}px`,
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
          fontWeight: active ? 500 : 400,
          color: active ? COLOR.text : COLOR.text4,
          background: 'transparent',
          borderRadius: 4,
          cursor: 'pointer',
          transition: 'all 0.15s',
        }}
      >
        {candidate.label}
      </button>
      {onRemove && hover && (
        <button
          onClick={(e) => { e.stopPropagation(); if (window.confirm(`删除候选「${candidate.label}」？`)) onRemove(); }}
          style={{
            position: 'absolute', right: 2, top: '50%', transform: 'translateY(-50%)',
            width: 14, height: 14, borderRadius: 3,
            background: 'rgba(0,0,0,0.06)',
            color: COLOR.sub,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(184,58,42,0.15)'; e.currentTarget.style.color = COLOR.error; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.06)'; e.currentTarget.style.color = COLOR.sub; }}
          title="删除候选"
        >
          <X size={9} />
        </button>
      )}
    </div>
  );
}
