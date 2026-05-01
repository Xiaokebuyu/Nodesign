import { useState } from 'react';
import { ChevronDown, CheckCircle2 } from 'lucide-react';
import Message from './Message.jsx';
import TimelineNode from './TimelineNode.jsx';
import { TimelinePositionProvider } from './TimelineGroupContext.js';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO } from '../../lib/theme.js';

/**
 * TimelineGroup —— 把连续的 thinking + tool 节点包成一个可折叠的"思考片段"
 *
 * 设计意图（参考用户图）：
 *   - 顶部 collapsible 标题栏：从第一段 thinking 自动提取一句话作 summary
 *     （像 Claude Code native UI "Architecting data structure..." 风格）
 *     props.summary 仍可显式传入覆盖（未来可接 LLM 实时总结）
 *   - 中部：连续的 thinking / tool TimelineNode，竖线自动连成时间轴
 *   - 底部（仅 closed=true 时）：CheckCircle2 + "DONE" 节点，标记该思考片段
 *     收尾，准备开始正式 assistant 回复
 *
 * closed 由 MessageList groupMessages 计算：group 后面出现非 thinking/tool
 * 消息（即 assistant 正式回复 / system / user）→ closed=true。run 还在进行
 * 中且 group 是最后一组 → closed=false（Done 不显示，避免误导）。
 */
const SUMMARY_MAX = 60;

/**
 * 从第一段 thinking 提取 summary 给 group 标题用。简单截取第一段（按双换行分），
 * 折叠空白，截前 SUMMARY_MAX 字符。失败 / 没 thinking 返 null（让上层用占位）。
 *
 * 不调 LLM —— Claude 的 thinking 通常以"用户在问 X..." / "I'm going to..." /
 * "我要 X..."开头，截前 60 字符已经能近似 native UI 那种"Architecting X" 风格。
 * 如果将来想要更精确的标题（句法清理 / 名词短语提取），把 summary prop 显式
 * 传进来覆盖。
 */
function extractSummary(messages) {
  const firstThinking = messages.find(m => m.role === 'thinking' && m.content);
  if (!firstThinking) return null;
  const text = String(firstThinking.content).trim();
  if (!text) return null;
  const firstPara = text.split(/\n{2,}/)[0].replace(/\s+/g, ' ').trim();
  if (!firstPara) return null;
  return firstPara.length > SUMMARY_MAX
    ? firstPara.slice(0, SUMMARY_MAX) + '…'
    : firstPara;
}

export default function TimelineGroup({ messages, closed, summary }) {
  const [open, setOpen] = useState(true);

  if (!messages || messages.length === 0) return null;

  const isActive = !closed && messages.some(m =>
    m.isStreaming || m.status === 'running' || m.taskStatus === 'running',
  );
  const stepCount = messages.length;

  // 优先级：显式 prop > 自动提取 > 占位文案
  const title = summary
    || extractSummary(messages)
    || (isActive ? 'Agent 思考中…' : `Agent 思考过程（${stepCount} 步）`);

  return (
    <div style={{ padding: `${GAP.xs}px 0 ${GAP.sm}px` }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: GAP.sm,
          width: '100%',
          padding: `${GAP.xs + 2}px ${GAP.lg}px`,
          fontFamily: FONT_SANS, fontSize: 13,
          fontWeight: 500,
          color: isActive ? COLOR.warn : COLOR.text2,
          background: 'transparent',
          border: 'none',
          borderRadius: 4,
          cursor: 'pointer',
          textAlign: 'left',
          transition: 'background 0.15s, color 0.15s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(0,0,0,0.025)';
          e.currentTarget.style.color = isActive ? COLOR.warn : COLOR.text1;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = isActive ? COLOR.warn : COLOR.text2;
        }}
      >
        <span style={{
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          minWidth: 0, flex: 1,
          lineHeight: 1.5,
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
          {messages.map((m, i) => {
            // 给每个节点算 timeline 位置（Context 让 TimelineNode 自己读，
            // 修最后一个节点线段溢出 + 第一个节点线段顶部多余的 bug）
            const isFirst = i === 0;
            const isLastMsg = i === messages.length - 1;
            // 关上的 group 末尾还有 done node → 当前 message 不算 last
            const isLast = isLastMsg && !closed;
            const position = (isFirst && isLast)
              ? 'only'
              : isFirst
                ? 'first'
                : isLast
                  ? 'last'
                  : 'middle';
            return (
              <TimelinePositionProvider key={m.id || `tl-${i}`} value={position}>
                <Message message={m} />
              </TimelinePositionProvider>
            );
          })}
          {closed && (
            <TimelinePositionProvider value="last">
              <TimelineNode icon={CheckCircle2} iconColor={COLOR.success}>
                <span style={{
                  fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
                  color: COLOR.sub, fontWeight: 500,
                  letterSpacing: '0.06em',
                }}>
                  DONE
                </span>
              </TimelineNode>
            </TimelinePositionProvider>
          )}
        </>
      )}
    </div>
  );
}
