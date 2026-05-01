import { CheckCircle2, Circle, Loader2 } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';

/**
 * TodoPanel — 消费 SDK TodoWrite 工具的实时计划清单
 *
 * 数据来自 run.todo.updated 事件 → Project.jsx 维护的 todos state。
 * 每条 todo: { content, activeForm, status: 'pending'|'in_progress'|'completed' }
 *
 * UI 位置：ChatPanel header 下方 / MessageList 上方（flex 布局自然吸顶）。
 *
 * - 空 todos 不渲染（无占位）
 * - in_progress 用 activeForm（"正在分析…"）+ 旋转 icon + 高亮
 * - completed 划线 + 灰
 * - pending 默认色
 * - maxHeight + 内滚，超出不挤占消息流
 */
export default function TodoPanel({ todos = [] }) {
  if (!todos || todos.length === 0) return null;

  const completed = todos.filter(t => t.status === 'completed').length;
  const total = todos.length;
  const allDone = completed === total && total > 0;

  return (
    <div style={{
      padding: `${GAP.sm}px ${GAP.lg}px ${GAP.sm + 2}px`,
      borderBottom: `1px solid ${COLOR.borderLt}`,
      background: 'rgba(45, 36, 24, 0.025)',
      maxHeight: 200,
      overflowY: 'auto',
      flexShrink: 0,
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        marginBottom: GAP.xs + 1,
      }}>
        <span style={{
          fontFamily: FONT_MONO, fontSize: 10, fontWeight: 500,
          color: COLOR.text2, letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}>计划</span>
        <span style={{
          fontFamily: FONT_MONO, fontSize: 10,
          color: allDone ? COLOR.success : COLOR.sub,
        }}>{completed}/{total}</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {todos.map((t, i) => <TodoRow key={i} todo={t} />)}
      </div>

      <style>{`
        @keyframes nd-todo-spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

function TodoRow({ todo }) {
  const { content, activeForm, status } = todo;
  const isCompleted = status === 'completed';
  const isActive = status === 'in_progress';
  const text = isActive ? (activeForm || content) : content;

  const Icon = isCompleted ? CheckCircle2 : (isActive ? Loader2 : Circle);
  const iconColor = isCompleted ? COLOR.success : (isActive ? COLOR.warn : COLOR.dim);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: GAP.sm,
      fontFamily: FONT_SANS,
      fontSize: FONT_SIZE.xs,
      color: isCompleted ? COLOR.sub : (isActive ? COLOR.text : COLOR.text2),
      lineHeight: 1.5,
    }}>
      <Icon
        size={11}
        color={iconColor}
        style={{
          flexShrink: 0,
          animation: isActive ? 'nd-todo-spin 1.5s linear infinite' : undefined,
        }}
      />
      <span style={{
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        textDecoration: isCompleted ? 'line-through' : 'none',
        fontWeight: isActive ? 500 : 400,
      }} title={text}>{text}</span>
    </div>
  );
}
