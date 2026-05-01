import { useState } from 'react';
import { ChevronDown, CheckCircle2 } from 'lucide-react';
import Message from './Message.jsx';
import TimelineNode from './TimelineNode.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO } from '../../lib/theme.js';

/**
 * TimelineGroup —— 把连续的 thinking + tool 节点包成一个可折叠的"思考片段"
 *
 * 设计意图（参考用户图）：
 *   - 顶部 collapsible 标题栏：占位文案"Agent 思考中…"/"Agent 思考过程（N 步）"
 *     未来接便宜模型实时总结当前思考片段（"Architecting data structure..."）→ 把
 *     summary prop 接上即可，不必动结构
 *   - 中部：连续的 thinking / tool TimelineNode，竖线自动连成时间轴
 *   - 底部（仅 closed=true 时）：CheckCircle2 + "DONE" 节点，标记该思考片段
 *     收尾，准备开始正式 assistant 回复
 *
 * closed 由 MessageList groupMessages 计算：group 后面出现非 thinking/tool
 * 消息（即 assistant 正式回复 / system / user）→ closed=true。run 还在进行
 * 中且 group 是最后一组 → closed=false（Done 不显示，避免误导）。
 */
export default function TimelineGroup({ messages, closed, summary }) {
  const [open, setOpen] = useState(true);

  if (!messages || messages.length === 0) return null;

  const isActive = !closed && messages.some(m =>
    m.isStreaming || m.status === 'running' || m.taskStatus === 'running',
  );
  const stepCount = messages.length;

  const title = summary
    || (isActive ? 'Agent 思考中…' : `Agent 思考过程（${stepCount} 步）`);

  return (
    <div style={{ padding: `${GAP.xs}px 0 ${GAP.sm}px` }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: GAP.sm,
          width: '100%',
          padding: `${GAP.sm}px ${GAP.lg}px`,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
          fontWeight: 500,
          color: isActive ? COLOR.warn : COLOR.text2,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          borderRadius: 6,
          transition: 'background 0.15s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.025)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        <span style={{
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          minWidth: 0, flex: 1,
        }}>{title}</span>
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          color={COLOR.sub}
          style={{
            flexShrink: 0,
            transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 0.2s cubic-bezier(0.25, 1, 0.5, 1)',
          }}
        />
      </button>
      {open && (
        <>
          {messages.map((m, i) => <Message key={m.id || `tl-${i}`} message={m} />)}
          {closed && (
            <TimelineNode icon={CheckCircle2} iconColor={COLOR.success}>
              <span style={{
                fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
                color: COLOR.sub, fontWeight: 500,
                letterSpacing: '0.06em',
              }}>
                DONE
              </span>
            </TimelineNode>
          )}
        </>
      )}
    </div>
  );
}
