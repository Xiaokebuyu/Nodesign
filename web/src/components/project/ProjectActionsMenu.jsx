import { useEffect, useRef } from 'react';
import { Edit2, Copy, Trash2, History, Code2, Camera, ArrowUpRight } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_SANS } from '../../lib/theme.js';

/**
 * 顶栏 ⋯ 菜单（项目操作）
 *
 * isQuickProject=true 时显示「升级为项目」入口（闪聊→标准项目，PATCH kind）
 */
export default function ProjectActionsMenu({
  open, onClose, anchorRef,
  onRename, onDuplicate, onDelete, onHistory, onViewCode,
  onSaveSnapshot, onOpenSnapshots, snapshotCount = 0,
  onUpgrade, isQuickProject = false,
}) {
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target) && !anchorRef?.current?.contains(e.target)) {
        onClose?.();
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute', top: 'calc(100% + 6px)', right: 0,
        minWidth: 180,
        background: '#fff',
        border: `1px solid ${COLOR.borderMd}`,
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06)',
        padding: 4,
        zIndex: 50,
      }}
    >
      {isQuickProject && (
        <>
          <Item
            icon={<ArrowUpRight size={12} />}
            label="升级为项目"
            onClick={onUpgrade}
            subtle="对话"
          />
          <div style={{ height: 1, background: COLOR.borderLt, margin: `${GAP.xs}px ${GAP.sm}px` }} />
        </>
      )}
      <Item icon={<Edit2 size={12} />} label="重命名" onClick={onRename} />
      <Item icon={<Copy size={12} />} label="复制项目" onClick={onDuplicate} />
      <div style={{ height: 1, background: COLOR.borderLt, margin: `${GAP.xs}px ${GAP.sm}px` }} />
      <Item icon={<Camera size={12} />} label="保存快照" onClick={onSaveSnapshot} />
      <Item
        icon={<History size={12} />}
        label="快照与历史"
        onClick={onOpenSnapshots}
        subtle={snapshotCount > 0 ? String(snapshotCount) : null}
      />
      <Item icon={<Code2 size={12} />} label="查看 spec JSON" onClick={onViewCode} subtle="debug" />
      <div style={{ height: 1, background: COLOR.borderLt, margin: `${GAP.xs}px ${GAP.sm}px` }} />
      <Item icon={<Trash2 size={12} />} label="删除项目" onClick={onDelete} danger />
    </div>
  );
}

function Item({ icon, label, onClick, danger, subtle }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        display: 'flex', alignItems: 'center', gap: GAP.sm,
        padding: `${GAP.sm}px ${GAP.md + 2}px`,
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
        color: danger ? COLOR.error : COLOR.text2,
        background: 'transparent',
        borderRadius: 4,
        cursor: 'pointer',
        textAlign: 'left',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = danger ? 'rgba(184,58,42,0.08)' : 'rgba(0,0,0,0.04)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
    >
      {icon}
      <span style={{ flex: 1 }}>{label}</span>
      {subtle && (
        <span style={{ fontFamily: 'inherit', fontSize: 10, color: COLOR.sub, opacity: 0.7 }}>{subtle}</span>
      )}
    </button>
  );
}
