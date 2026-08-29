import { FolderOpen, Trash2, MessageSquarePlus } from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_SANS, FONT_SIZE, CANVAS, alpha } from '../../../lib/theme.js';
import { EASE, POP_IN } from '../../../lib/board-geometry.js';
import FolderFace from './FolderFace.jsx';
import NoteBadge from './NoteBadge.jsx';

/**
 * FolderCard —— 文件夹的那张方卡（2026-08-13 从 BoardCanvas 拆出来）。
 *
 * 拆的理由不是"文件太长"，是**同一张卡现在有两个地方要画**：桌面上一张、
 * 文件夹窗里一张。抄两遍的代价这个仓库已经付过一次（deck/站点/世界的卡抄了
 * 六遍，最后表现是"站点和世界用同一个图标，画布上一眼分不出"）。
 *
 * 位置永远由 `z.x/z.y` 定（跟 BoardObject 一样是绝对定位）——桌面传的是世界
 * 坐标，窗里传的是网格算出来的坐标，卡自己不关心那是哪套坐标系。
 */

const headerBtn = {
  border: 0, background: 'transparent', cursor: 'pointer',
  color: COLOR.text, display: 'flex', padding: GAP.xxs,
};

export default function FolderCard({
  z, projectId, fileVersions, scale = 1,
  /** 有东西正拖到这张卡上（松手就搬进去）*/
  dropTarget = false,
  selected = false,
  /** agent 正在这个文件夹里干活 */
  ring = false,
  dragging = false,
  /** 位置变化要不要滑动过渡（拖拽中的那张要逐帧跟手，关掉）*/
  animate = true,
  renaming = false,
  onRenameCommit, onRenameCancel, onDelete, onAnnotate,
  gestureProps = {},
  hint = '双击打开 · 拖动搬走',
  noteCount = 0,
}) {
  return (
    <div
      data-board-zone={z.id}
      {...gestureProps}
      title={`${z.title} · ${hint}`}
      style={{
        position: 'absolute', left: z.x, top: z.y, width: z.w, height: z.h,
        zIndex: dragging ? 20 : 1,
        display: 'flex', flexDirection: 'column',
        background: dropTarget ? '#fff8e8' : COLOR.bgCard,
        border: `1px solid ${dropTarget ? CANVAS.brass : COLOR.borderLt}`,
        borderRadius: RADIUS.xl,
        boxShadow: dropTarget
          ? `0 0 0 3px ${alpha(CANVAS.brass, 0.18)}, 0 8px 20px rgba(43,33,23,0.14)`
          : '0 1px 4px rgba(43,33,23,0.05)',
        // 窗里的卡不参与拖拽（位置是算出来的），别给一个骗人的抓手光标
        cursor: dragging ? 'grabbing' : (gestureProps.onPointerDown ? 'grab' : 'pointer'),
        ...(selected ? { outline: `2px solid ${CANVAS.brass}`, outlineOffset: 1 } : null),
        userSelect: 'none', touchAction: 'none',
        transition: `background 150ms, border-color 150ms, box-shadow 150ms${animate ? `, left 380ms ${EASE}, top 380ms ${EASE}` : ''}`,
        animation: ring ? 'ndAgentRing 1600ms ease-in-out infinite' : POP_IN,
      }}
    >
      <NoteBadge count={noteCount} />

      {/* 卡面：里面前几件的真缩略（FolderFace，2026-08-13 从名字清单
          升级；iframe 的三道闸 —— 视口/缩放/每卡上限 —— 在那边算） */}
      <FolderFace z={z} projectId={projectId} fileVersions={fileVersions} scale={scale} />

      <div style={{
        height: 40, flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: GAP.xs,
        padding: `0 ${GAP.sm}px`,
        borderTop: `1px solid ${COLOR.borderLt}`,
      }}>
        <FolderOpen size={12} color={COLOR.sub} style={{ flexShrink: 0 }} />
        {renaming ? (
          <input
            data-zone-action
            autoFocus
            defaultValue={z.title}
            onPointerDown={(e) => e.stopPropagation()}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              // Enter 提交、Esc 放弃。**都要 stopPropagation** —— 画布上
              // Esc 是关窗/收选中、单键是换工具，不拦住的话打字就在换工具
              e.stopPropagation();
              if (e.key === 'Enter') onRenameCommit?.(e.currentTarget.value);
              if (e.key === 'Escape') onRenameCancel?.();
            }}
            onBlur={(e) => onRenameCommit?.(e.currentTarget.value)}
            style={{
              flex: 1, minWidth: 0, border: `1px solid ${CANVAS.brass}`,
              borderRadius: RADIUS.sm, padding: '1px 4px', outline: 'none',
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 600,
              color: COLOR.text, background: COLOR.bgWhite,
            }}
          />
        ) : (
          <span style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 600, color: COLOR.text,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0,
          }}>{z.title}</span>
        )}
        {onAnnotate && (
          <button
            data-zone-action title="标注（发给 agent / 留在画布）"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onAnnotate({ x: r.left, y: r.bottom + 6 });
            }}
            style={headerBtn}
          ><MessageSquarePlus size={12} /></button>
        )}
        {onDelete && (
          <button
            data-zone-action title="删除文件夹（连同里面的内容；不影响对话）"
            onClick={onDelete}
            style={{ ...headerBtn, color: COLOR.error }}
          ><Trash2 size={12} /></button>
        )}
      </div>
    </div>
  );
}
