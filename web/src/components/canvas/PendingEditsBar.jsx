/**
 * PendingEditsBar — 画布底部固定 "N 处调整待应用" 操作栏
 *
 * 仅当 edits.length > 0 时出现。提供 3 个动作：
 *   - 应用    → onApply()（外部触发：在聊天框塞预设消息 → 走现有 Turn.send → agent run）
 *   - 撤销    → onUndo() (Cmd+Z)
 *   - 全部撤销 → onClearAll()
 *
 * Bar 浮在 canvas 底部、半透明、低调；不抢主区面积。
 */

import { Send, Undo2, X } from 'lucide-react';
import { COLOR, FONT_MONO, FONT_SIZE, GAP, RADIUS } from '../../lib/theme.js';

export default function PendingEditsBar({
  edits = [],
  onApply,
  onUndo,
  onClearAll,
  canUndo = false,
  isRunning = false,
}) {
  const count = edits.length;
  if (count === 0) return null;

  const summary = summarize(edits);

  return (
    <div style={{
      position: 'absolute',
      bottom: 16,
      left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgba(43,33,23, 0.94)',
      color: COLOR.btnText,
      borderRadius: RADIUS.lg,
      padding: `${GAP.sm}px ${GAP.lg}px`,
      display: 'flex',
      alignItems: 'center',
      gap: GAP.md,
      fontFamily: FONT_MONO,
      fontSize: FONT_SIZE.xs,
      boxShadow: '0 8px 32px rgba(93,74,44,0.275), 0 2px 8px rgba(93,74,44,0.198)',
      zIndex: 50,
      backdropFilter: 'blur(8px)',
      WebkitBackdropFilter: 'blur(8px)',
    }}>
      <span style={{
        padding: `${GAP.xxs}px ${GAP.md}px`,
        background: 'rgba(245, 240, 232, 0.15)',
        borderRadius: RADIUS.xl,
        fontWeight: 600,
        minWidth: 22,
        textAlign: 'center',
      }}>
        {count}
      </span>
      <span style={{ color: '#dfd6c6' }}>{summary} 待应用</span>

      <div style={{ width: 1, height: 18, background: 'rgba(245,240,232,0.2)' }} />

      <button
        onClick={onUndo}
        disabled={!canUndo}
        title={canUndo ? '撤销最近一次 (Cmd+Z)' : '无可撤销操作'}
        style={{
          ...btnStyleGhost,
          opacity: canUndo ? 1 : 0.4,
          cursor: canUndo ? 'pointer' : 'not-allowed',
        }}
      >
        <Undo2 size={11} /> 撤销
      </button>

      <button
        onClick={onClearAll}
        title="全部撤销 — 把所有 pending 编辑清掉"
        style={btnStyleGhost}
      >
        <X size={11} /> 全部撤销
      </button>

      <button
        onClick={onApply}
        disabled={isRunning}
        title={isRunning ? 'agent 正在跑，等当前 run 结束' : '让 agent 把这些调整落到源代码'}
        style={{
          ...btnStylePrimary,
          opacity: isRunning ? 0.6 : 1,
          cursor: isRunning ? 'wait' : 'pointer',
        }}
      >
        <Send size={11} /> 应用
      </button>
    </div>
  );
}

function summarize(edits) {
  const counts = { move: 0, style: 0, dup: 0, del: 0 };
  for (const e of edits) {
    if (e.kind === 'pending-move') counts.move++;
    else if (e.kind === 'pending-style') counts.style++;
    else if (e.kind === 'pending-duplicate') counts.dup++;
    else if (e.kind === 'pending-delete') counts.del++;
  }
  const parts = [];
  if (counts.move) parts.push(`${counts.move} 拖动`);
  if (counts.dup) parts.push(`${counts.dup} 复制`);
  if (counts.style) parts.push(`${counts.style} 样式`);
  if (counts.del) parts.push(`${counts.del} 删除`);
  return parts.join(' · ') || '调整';
}

const btnStyleGhost = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  padding: `${GAP.xs}px ${GAP.base}px`,
  fontFamily: 'inherit',
  fontSize: FONT_SIZE.xs,
  color: COLOR.btnText,
  background: 'transparent',
  border: '1px solid rgba(245,240,232,0.25)',
  borderRadius: RADIUS.sm,
};

// 反相按钮：条本身是深底，所以"主"按钮把主按钮的墨/纸对调 —— btn 当文字、btnText 当底
const btnStylePrimary = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  padding: '5px 14px',
  fontFamily: 'inherit',
  fontSize: FONT_SIZE.xs,
  fontWeight: 600,
  color: COLOR.btn,
  background: COLOR.btnText,
  border: 'none',
  borderRadius: RADIUS.sm,
  boxShadow: '0 1px 2px rgba(93,74,44,0.165)',
};
