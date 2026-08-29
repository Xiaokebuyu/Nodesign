import { useEffect, useRef } from 'react';
import { Edit2, Copy, Trash2, History, Code2, Camera, ArrowUpRight, RotateCcw,
  ScrollText, Files, Clapperboard } from 'lucide-react';
import { COLOR, GAP, RADIUS, SHADOW, FONT_SIZE, FONT_SANS } from '../../lib/theme.js';
import { t } from '../../lib/i18n.js';

/**
 * 顶栏 ⋯ 菜单（项目操作）
 *
 * isQuickProject=true 时显示「升级为项目」入口（闪聊→标准项目，PATCH kind）
 */
export default function ProjectActionsMenu({
  open, onClose, anchorRef,
  onRename, onDuplicate, onDelete, onHistory, onViewCode, onReload,
  onSaveSnapshot, onOpenSnapshots, snapshotCount = 0,
  onUpgrade, isQuickProject = false,
  // 项目模式（2026-08-27）：design=设计 / rp=演出。切换**下个会话生效**（服务端
  // 会话启动时读一次），所以这里只发 PATCH，生效时机由 subtle 提示说清。
  projectMode = 'design', onToggleMode = null,
  // 项目级四件套（2026-08-07 从画布顶带搬进来）。它们是**设置**不是产物：
  // 每天都在看却几乎不点，却占着画布最好的一条横带。
  onOpenProjectPanel = null, projectBand = null,
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
        background: COLOR.bgWhite,
        borderRadius: 2,
        boxShadow: SHADOW.pop,
        padding: GAP.xs,
        zIndex: 50,
      }}
    >
      {onOpenProjectPanel && (
        <>
          {PROJECT_PANELS.map(p => (
            <Item
              key={p.key}
              icon={<p.icon size={12} />}
              label={p.label}
              title={projectBand?.[p.key] || p.hint}
              onClick={() => { onOpenProjectPanel(p.key); onClose?.(); }}
            />
          ))}
          <div style={{ height: 1, background: COLOR.borderLt, margin: `${GAP.xs}px ${GAP.sm}px` }} />
        </>
      )}
      {isQuickProject && (
        <>
          <Item
            icon={<ArrowUpRight size={12} />}
            label={t('升级为项目')}
            onClick={onUpgrade}
            subtle={t('对话')}
          />
          <div style={{ height: 1, background: COLOR.borderLt, margin: `${GAP.xs}px ${GAP.sm}px` }} />
        </>
      )}
      {/* 刷新产物墙：同步失灵时的逃生舱，不是日常动作，2026-07-30 从顶栏收进来 */}
      {onReload && (
        <>
          <Item icon={<RotateCcw size={12} />} label={t('刷新产物墙')} onClick={onReload} />
          <div style={{ height: 1, background: COLOR.borderLt, margin: `${GAP.xs}px ${GAP.sm}px` }} />
        </>
      )}
      {onToggleMode && (
        <Item
          icon={<Clapperboard size={12} />}
          label={projectMode === 'rp' ? t('切回设计模式') : t('切到演出模式')}
          title={projectMode === 'rp'
            ? t('回到设计工作台（deck/站点/文档产线）')
            : t('常驻角色演故事的舞台；设计产线在该模式下收起')}
          onClick={onToggleMode}
          subtle={t('下个会话生效')}
        />
      )}
      <Item icon={<Edit2 size={12} />} label={t('重命名')} onClick={onRename} />
      <Item icon={<Copy size={12} />} label={t('复制项目')} onClick={onDuplicate} />
      <div style={{ height: 1, background: COLOR.borderLt, margin: `${GAP.xs}px ${GAP.sm}px` }} />
      <Item icon={<Camera size={12} />} label={t('保存快照')} onClick={onSaveSnapshot} />
      <Item
        icon={<History size={12} />}
        label={t('快照与历史')}
        onClick={onOpenSnapshots}
        subtle={snapshotCount > 0 ? String(snapshotCount) : null}
      />
      <Item icon={<Code2 size={12} />} label={t('查看 spec JSON')} onClick={onViewCode} subtle="debug" />
      <div style={{ height: 1, background: COLOR.borderLt, margin: `${GAP.xs}px ${GAP.sm}px` }} />
      <Item icon={<Trash2 size={12} />} label={t('删除项目')} onClick={onDelete} danger />
    </div>
  );
}

/**
 * 顶栏的演出模式徽记（2026-08-27）：设计是默认态不挂牌，只有演出亮一枚小签。
 * 纯识别、不可点 —— 切换在 ⋯ 菜单里。design 模式返回 null。
 */
export function ProjectModeBadge({ mode }) {
  if (mode !== 'rp') return null;
  return (
    <span
      title={t('演出模式：常驻角色演故事的舞台（切换在 ⋯ 菜单，下个会话生效）')}
      style={{
        font: '700 11px var(--kai, inherit)', letterSpacing: '0.2em', textIndent: '0.2em',
        color: 'rgba(168,54,43,0.9)', border: '1px solid rgba(168,54,43,0.55)',
        borderRadius: 999, padding: '2px 9px 3px', alignSelf: 'center',
        transform: 'rotate(-1deg)', userSelect: 'none',
      }}
    >{t('演出')}</span>
  );
}

// 08-24 记忆体系改版：记忆/风格卡退役（记忆住画布上的 记忆/，风格并进根 CLAUDE.md）
const PROJECT_PANELS = [
  { key: 'guide', label: '项目档案', icon: ScrollText, hint: '指引/风格/习惯，每次 session 进 system prompt' },
  { key: 'files', label: '项目文件', icon: Files, hint: 'agent 能直接 Read 的素材' },
];

function Item({ icon, label, onClick, danger, subtle, title }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: '100%',
        display: 'flex', alignItems: 'center', gap: GAP.sm,
        padding: `${GAP.sm}px ${GAP.md + 2}px`,
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
        color: danger ? COLOR.error : COLOR.text2,
        background: 'transparent',
        borderRadius: RADIUS.sm,
        cursor: 'pointer',
        textAlign: 'left',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = danger ? 'rgba(184,58,42,0.08)' : 'rgba(43,33,23,0.04)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
    >
      {icon}
      <span style={{ flex: 1 }}>{label}</span>
      {subtle && (
        <span style={{ fontFamily: 'inherit', fontSize: FONT_SIZE.xs, color: COLOR.sub, opacity: 0.7 }}>{subtle}</span>
      )}
    </button>
  );
}
